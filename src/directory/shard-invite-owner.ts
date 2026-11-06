import { AppError } from "../shared/errors";
import { directoryNameForUser } from "../shared/operations";
import { validShardInviteClaim, type ShardInviteClaim } from "./shard-invite-binding";

export type BoundShardInviteClaim = ShardInviteClaim & { provider: "google"; subject: string };

/**
 * Look up the creation-time claim independently stored by the coordinator.
 * A missing row is a legacy unknown, not proof that no invitation existed.
 * Call only inside the same input-gated turn or transaction as its use.
 */
export function boundShardInviteClaim(sql: SqlStorage, userId: string, email: string): BoundShardInviteClaim | null {
  const home = directoryNameForUser(userId);
  if (home === "global") throw new AppError("invalid", "invalid shard invitation owner");
  const shard = Number(home.slice("directory-".length));
  const rows = sql.exec<{
    provider: string; subject: string; token: string; email: string; generation: string | null;
    home_user: string | null; home_shard: number | null; placement_state: string | null;
    placement_generation: string | null; home_token: string | null;
  }>(`SELECT c.provider,c.subject,c.token,c.email,c.generation,
      h.user_id AS home_user,h.shard AS home_shard,h.placement_state,h.generation AS placement_generation,t.token AS home_token
    FROM shard_home_invite_claims c
    LEFT JOIN identity_homes h ON h.provider=c.provider AND h.subject=c.subject
    LEFT JOIN shard_home_claim_tokens t ON t.provider=c.provider AND t.subject=c.subject
    WHERE c.user_id=? LIMIT 2`, userId).toArray();
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new AppError("unavailable", "invitation binding requires review");
  const row = rows[0]!;
  const claim = { token: row.token, email: row.email, generation: row.generation };
  if (row.provider !== "google" || !row.subject || row.home_user !== userId || row.home_shard !== shard ||
      row.placement_state !== "open" || row.placement_generation !== null || row.home_token !== row.token ||
      !validShardInviteClaim(claim) || claim.email !== email)
    throw new AppError("unavailable", "invitation binding requires review");
  return { ...claim, provider: "google", subject: row.subject };
}
