/** Immutable authorization captured with a new Google shard-home claim. */
export interface ShardInviteClaim {
  token: string;
  email: string;
  /** Null is a verified absence; an absent record is an unknown legacy claim. */
  generation: string | null;
}

export const SHARD_INVITE_BINDING_MIGRATIONS: string[] = [
  `CREATE TABLE shard_home_invite_claims (
    provider TEXT NOT NULL, subject TEXT NOT NULL, token TEXT NOT NULL,
    email TEXT NOT NULL, generation TEXT, user_id TEXT,
    PRIMARY KEY(provider,subject)
  )`,
  `CREATE INDEX shard_home_invite_claims_user ON shard_home_invite_claims(user_id)`,
  `CREATE TABLE shard_invite_account_bindings (
    user_id TEXT PRIMARY KEY, provider TEXT NOT NULL, subject TEXT NOT NULL,
    token TEXT NOT NULL, email TEXT NOT NULL, generation TEXT
  )`,
  `CREATE TABLE shard_invite_bind_marker (provider TEXT NOT NULL,subject TEXT NOT NULL,token TEXT NOT NULL,PRIMARY KEY(provider,subject))`,
  `CREATE TRIGGER shard_invite_claim_immutable BEFORE UPDATE ON shard_home_invite_claims
   WHEN NEW.provider IS NOT OLD.provider OR NEW.subject IS NOT OLD.subject OR NEW.token IS NOT OLD.token
     OR NEW.email IS NOT OLD.email OR NEW.generation IS NOT OLD.generation
     OR (OLD.user_id IS NOT NULL AND NEW.user_id IS NOT OLD.user_id)
   BEGIN SELECT RAISE(ABORT, 'shard_invite_claim_immutable'); END`,
  `CREATE TRIGGER shard_invite_claim_user_bind BEFORE UPDATE OF user_id ON shard_home_invite_claims
   WHEN NEW.user_id IS NOT OLD.user_id AND NOT EXISTS(SELECT 1 FROM shard_invite_bind_marker m
     WHERE m.provider=OLD.provider AND m.subject=OLD.subject AND m.token=OLD.token)
   BEGIN SELECT RAISE(ABORT, 'shard_invite_binding_required'); END`,
  `CREATE TRIGGER shard_invite_account_immutable BEFORE UPDATE ON shard_invite_account_bindings
   BEGIN SELECT RAISE(ABORT, 'shard_invite_binding_immutable'); END`,
  `CREATE TRIGGER shard_invite_claim_home_bind BEFORE UPDATE OF user_id ON identity_homes
   WHEN OLD.user_id IS NULL AND NEW.user_id IS NOT NULL
    AND EXISTS(SELECT 1 FROM shard_home_invite_claims c WHERE c.provider=OLD.provider AND c.subject=OLD.subject)
    AND NOT EXISTS(SELECT 1 FROM shard_invite_bind_marker m JOIN shard_home_invite_claims c
      ON c.provider=m.provider AND c.subject=m.subject AND c.token=m.token
      WHERE m.provider=OLD.provider AND m.subject=OLD.subject)
   BEGIN SELECT RAISE(ABORT, 'shard_invite_binding_required'); END`,
  ...['INSERT','UPDATE','DELETE'].map((action) =>
    `CREATE TRIGGER shard_invite_claim_barrier_${action.toLowerCase()} BEFORE ${action} ON shard_home_invite_claims
     WHEN EXISTS(SELECT 1 FROM invite_inventory_barrier WHERE slot=1)
     BEGIN SELECT RAISE(ABORT, 'invite_inventory_barrier_active'); END`),
  `CREATE TRIGGER remove_shard_home_invite_claim AFTER DELETE ON identity_homes
   BEGIN DELETE FROM shard_home_invite_claims WHERE provider=OLD.provider AND subject=OLD.subject; END`,
  `CREATE TRIGGER remove_shard_invite_account_binding AFTER DELETE ON users
   BEGIN DELETE FROM shard_invite_account_bindings WHERE user_id=OLD.user_id; END`,
];

export function validShardInviteClaim(value: unknown): value is ShardInviteClaim {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const claim = value as Record<string, unknown>;
  return Object.keys(claim).length === 3 && typeof claim.token === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claim.token) &&
    typeof claim.email === 'string' && claim.email.length > 0 && claim.email.length <= 320 &&
    claim.email === claim.email.trim().toLowerCase() &&
    (claim.generation === null || (typeof claim.generation === 'string' && /^[a-f0-9]{32}$/.test(claim.generation)));
}
