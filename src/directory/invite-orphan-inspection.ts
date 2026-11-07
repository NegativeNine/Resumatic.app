import { AppError } from "../shared/errors";
import { directoryNameForUser } from "../shared/operations";
import { validShardInviteClaim } from "./shard-invite-binding";
import type { RevokedShardClaim, ShardClaimObservation } from "./shard-claim-revocation";
import type { InviteRevocationStatus } from "./invite-revocation";

const operationId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const userId = /^(?:s(?:[0-9]|1[0-5]):)?[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const unavailable = () => new AppError("unavailable", "invitation account inventory requires review");

type Fence = { operation_id: string; email: string; email_fingerprint: string; generation: string | null };
type Entry = { placement: "global" | "shard"; user_id: string; vault_id: string; shard: number | null;
  provider: string; subject: string; token: string | null; email: string | null; generation: string | null };
type LocalObservation = ShardClaimObservation & { placement: "global"; shard: null };
type Candidate = { entry: Entry; observation?: LocalObservation; claim?: RevokedShardClaim };
type Snapshot = { fence: Fence; status: InviteRevocationStatus; candidates: Candidate[]; nextCursor: string | null };

export interface InviteOrphanInspectionDeps {
  sql: SqlStorage;
  transaction: <T>(fn: () => T) => T;
  status: (operation: string) => InviteRevocationStatus;
  fingerprint: (operation: string, email: string) => Promise<string>;
  validVault: (vaultId: string) => boolean;
  inspectShard: (claim: RevokedShardClaim) => Promise<ShardClaimObservation>;
}

/** Point-in-time read only. No result authorizes a bind, fence removal or erasure. */
export class InviteOrphanInspection {
  constructor(private readonly d: InviteOrphanInspectionDeps) {}

  private fence(operation: string): Fence {
    const rows = this.d.sql.exec<Fence>(`SELECT operation_id,email,email_fingerprint,generation FROM invite_revocation_fences WHERE operation_id=? LIMIT 2`, operation).toArray();
    const row = rows[0];
    if (rows.length !== 1 || !row || row.operation_id !== operation || typeof row.email !== "string" ||
        !row.email || row.email.length > 320 || row.email !== row.email.trim().toLowerCase() ||
        typeof row.email_fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(row.email_fingerprint) ||
        (row.generation !== null && (typeof row.generation !== "string" || !/^[a-f0-9]{32}$/.test(row.generation)))) throw unavailable();
    return row;
  }

  private snapshot(operation: string, after: string | null, limit: number, expected: Fence): Snapshot {
    const fence = this.fence(operation);
    if (JSON.stringify(fence) !== JSON.stringify(expected)) throw unavailable();
    const status = this.d.status(operation);
    if (status.state !== "pending" || status.inventoryPending || status.remaining !== status.orphans) throw unavailable();
    const source = `SELECT 'global' AS placement,user_id,vault_id,NULL AS shard,provider,subject,NULL AS token,NULL AS email,NULL AS generation
      FROM invite_revocation_global_orphans WHERE operation_id=?
      UNION ALL SELECT 'shard' AS placement,user_id,vault_id,shard,provider,subject,token,email,generation
      FROM invite_revocation_claims WHERE operation_id=? AND state='created'`;
    const count = this.d.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM (${source}) LIMIT 2001)`, operation, operation).one().n;
    if (!Number.isSafeInteger(status.remaining) || !Number.isSafeInteger(status.orphans) || status.remaining < status.orphans ||
        status.orphans < 0 || count > 2000 || count !== status.orphans) throw unavailable();
    if (this.d.sql.exec(`SELECT user_id FROM (${source}) GROUP BY user_id HAVING COUNT(*)<>1 LIMIT 1`, operation, operation).toArray().length) throw unavailable();
    const entries = this.d.sql.exec<Entry>(`SELECT * FROM (${source}) WHERE (? IS NULL OR user_id>?) ORDER BY user_id LIMIT ?`, operation, operation, after, after, limit + 1).toArray();
    const candidates = entries.map((entry): Candidate => {
      if ((entry.placement !== "global" && entry.placement !== "shard") || typeof entry.user_id !== "string" || !userId.test(entry.user_id) ||
          typeof entry.vault_id !== "string" || !/^[a-f0-9]{64}$/i.test(entry.vault_id) || !this.d.validVault(entry.vault_id) ||
          entry.provider !== "google" || typeof entry.subject !== "string" || !entry.subject || entry.subject.length > 1024) throw unavailable();
      if (entry.placement === "global") {
        if (entry.shard !== null || entry.token !== null || entry.email !== null || entry.generation !== null || directoryNameForUser(entry.user_id) !== "global") throw unavailable();
        const rows = this.d.sql.exec<{ user_id: string; email: string; user_state: string; vault_id: string; vault_state: string;
          home_provider: string | null; home_shard: number | null; home_user: string | null; home_state: string | null; home_generation: string | null;
          binding_user: string | null; binding_email: string | null }>(`SELECT i.user_id,u.email,u.state AS user_state,v.vault_id,v.state AS vault_state,
            h.provider AS home_provider,h.shard AS home_shard,h.user_id AS home_user,h.placement_state AS home_state,h.generation AS home_generation,
            b.user_id AS binding_user,b.email AS binding_email
          FROM identities i JOIN users u ON u.user_id=i.user_id JOIN vaults v ON v.user_id=i.user_id
          LEFT JOIN identity_homes h ON h.provider=i.provider AND h.subject=i.subject
          LEFT JOIN account_invite_bindings b ON b.user_id=i.user_id WHERE i.provider=? AND i.subject=? LIMIT 2`, entry.provider, entry.subject).toArray();
        const row = rows[0];
        if (rows.length !== 1 || !row || row.user_id !== entry.user_id || row.vault_id !== entry.vault_id || row.email !== fence.email ||
            !["active", "deleting"].includes(row.user_state) || !["creating", "active", "deleting", "swept"].includes(row.vault_state) ||
            (row.home_provider !== null && (row.home_provider !== entry.provider || row.home_shard !== null || row.home_user !== null || row.home_state !== "open" || row.home_generation !== null)) ||
            (row.binding_user !== null && (row.binding_user !== row.user_id || row.binding_email !== fence.email))) throw unavailable();
        return { entry, observation: { placement: "global", shard: null, userId: row.user_id, vaultId: row.vault_id,
          userState: row.user_state as ShardClaimObservation["userState"], vaultState: row.vault_state as ShardClaimObservation["vaultState"],
          initializationMarkerPresent: this.d.sql.exec(`SELECT vault_id FROM vault_initializations WHERE vault_id=? LIMIT 1`, row.vault_id).toArray().length > 0 } };
      }
      if (!Number.isInteger(entry.shard) || entry.shard! < 0 || entry.shard! > 15 || directoryNameForUser(entry.user_id) !== `directory-${entry.shard}` ||
          !validShardInviteClaim({ token: entry.token, email: entry.email, generation: entry.generation }) || entry.email !== fence.email) throw unavailable();
      const rows = this.d.sql.exec<{ shard: number | null; user_id: string | null; generation: string | null; placement_state: string;
        home_token: string | null; claim_token: string | null; claim_email: string | null; claim_generation: string | null; claim_user: string | null }>(
        `SELECT h.shard,h.user_id,h.generation,h.placement_state,t.token AS home_token,
                c.token AS claim_token,c.email AS claim_email,c.generation AS claim_generation,c.user_id AS claim_user
         FROM identity_homes h LEFT JOIN shard_home_claim_tokens t ON t.provider=h.provider AND t.subject=h.subject
         LEFT JOIN shard_home_invite_claims c ON c.provider=h.provider AND c.subject=h.subject WHERE h.provider=? AND h.subject=? LIMIT 2`, entry.provider, entry.subject).toArray();
      const row = rows[0];
      if (rows.length !== 1 || !row || row.shard !== entry.shard || row.user_id !== null || row.generation !== null || row.placement_state !== "open" ||
          row.home_token !== entry.token || row.claim_token !== entry.token || row.claim_email !== entry.email || row.claim_generation !== entry.generation || row.claim_user !== null) throw unavailable();
      return { entry, claim: { operationId: operation, provider: "google", subject: entry.subject, shard: entry.shard!,
        token: entry.token!, email: entry.email!, generation: entry.generation } };
    });
    return { fence, status, candidates: candidates.slice(0, limit), nextCursor: entries.length > limit ? entries[limit - 1]!.user_id : null };
  }

  async inspect(operation: string, after: string | null = null, limit = 25) {
    if (typeof operation !== "string" || !operationId.test(operation) || (after !== null && (typeof after !== "string" || !userId.test(after))) ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > 25) throw new AppError("invalid", "invalid invitation account inventory page");
    const initialStatus = this.d.status(operation);
    if (initialStatus.state === "unknown" || initialStatus.state === "complete") throw new AppError("not_found", "pending invitation revocation not found");
    if (!Number.isSafeInteger(initialStatus.remaining) || !Number.isSafeInteger(initialStatus.orphans) ||
        initialStatus.orphans < 0 || initialStatus.remaining < initialStatus.orphans) throw unavailable();
    if (initialStatus.inventoryPending || initialStatus.remaining !== initialStatus.orphans) return { status: "pending" as const, inventoryPending: true as const,
      scope: "directory_observation_only" as const, accounts: [], nextCursor: null };
    const expected = this.fence(operation);
    if (await this.d.fingerprint(operation, expected.email) !== expected.email_fingerprint) throw unavailable();
    const before = this.d.transaction(() => this.snapshot(operation, after, limit, expected));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const readTargets = Promise.all(before.candidates.map(async ({ entry, observation, claim }) => {
      if (observation) return observation;
      if (!claim) throw unavailable();
      const target = await this.d.inspectShard(claim);
      if (!target || target.userId !== entry.user_id || target.vaultId !== entry.vault_id ||
          !["active", "deleting"].includes(target.userState) || !["creating", "active", "deleting", "swept"].includes(target.vaultState) ||
          typeof target.initializationMarkerPresent !== "boolean") throw unavailable();
      return { placement: "shard" as const, shard: claim.shard, userId: target.userId, vaultId: target.vaultId,
        userState: target.userState, vaultState: target.vaultState, initializationMarkerPresent: target.initializationMarkerPresent };
    }));
    let observed: Awaited<typeof readTargets>;
    try {
      observed = await Promise.race([readTargets, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(unavailable()), 5000); })]);
    } catch { throw unavailable(); }
    finally { if (timer !== undefined) clearTimeout(timer); }
    const afterRead = this.d.transaction(() => this.snapshot(operation, after, limit, expected));
    if (JSON.stringify(before) !== JSON.stringify(afterRead)) throw unavailable();
    return { status: "pending" as const, inventoryPending: false as const, scope: "directory_observation_only" as const,
      totalOrphans: before.status.state === "pending" ? before.status.orphans : 0,
      accounts: observed, nextCursor: before.nextCursor };
  }
}
