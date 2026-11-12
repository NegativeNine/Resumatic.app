import { revokeOAuthUserGrants } from "../worker/mcp";
import { BillingStore } from "./billing";
import { cleanupBillingCustomer, type BillingEvent } from "../worker/billing";
import { directory, directoryByName } from "../shared/stubs";
import { directoryNameForUser, requireMaintenanceFence, shardedUserId } from "../shared/operations";
import { DurableObject } from "cloudflare:workers";
import { AppError, logErrorCode } from "../shared/errors";
import { requireFreshAuth } from "../shared/auth-expiry";
import { isMissingWorkflowInstance } from "../shared/workflow-errors";
import { deletePrefix, vaultPrefix } from "../shared/r2";
import type { SignInInput, VaultRow } from "../shared/types";
import { migrateDirectory } from "./schema";
import { PlacementFence, syntheticPlacementIdentity, type PlacementAttempt } from "./placement-fence";
import { InviteInventory, type ShardInviteInventory } from "./invite-inventory";
import type { InviteTarget } from "./invite-target-seal";
import { InviteCoordinator, type InventoryIdentity } from "./invite-coordinator";
import { validShardInviteClaim, type ShardInviteClaim } from "./shard-invite-binding";
import { boundShardInviteClaim } from "./shard-invite-owner";
import { ShardClaimRevocation, type RevokedShardClaim, type ShardClaimSeal, type ShardClaimObservation } from "./shard-claim-revocation";
import { InviteRevocation, type InviteRevocationStatus } from "./invite-revocation";
import { InviteOrphanInspection } from "./invite-orphan-inspection";
import { OperatorSpendStore } from "./operator-spend";
import type { ModelAttempt } from "../ai/usage";

/** How soon a failed deletion is retried. */
const RETRY_MS = 60_000;

/** Bounded, work-conserving lanes: a stuck item consumes one slot, not a whole batch. */
async function eachConcurrent<T>(items: readonly T[], task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await task(item);
    }
  }));
}

function parseCheckoutIds(value: string): string[] {
  try {
    const ids: unknown = JSON.parse(value);
    if (!Array.isArray(ids) || ids.length > 2000 || ids.some((id) => typeof id !== "string" || id.length > 255 || !/^cs_[A-Za-z0-9_]+$/.test(id))) throw new Error();
    return ids;
  } catch {
    throw new AppError("unavailable", "checkout history requires operator review");
  }
}

type AccountRow = {
  user_id: string;
  user_state: string;
  vault_id: string;
  vault_state: string;
  hint: string;
};

type VaultDbRow = {
  stripe_customer: string | null;
  stripe_checkout_sessions: string;
  vault_id: string;
  user_id: string;
  email: string;
  hint: string;
  state: string;
  swept_at: number | null;
  updated_at: number;
  final_generation: string | null;
  final_phase: string | null;
  invite_closed: number | null;
  invite_operation: string | null;
};

type RetiredVaultDbRow = {
  vault_id: string;
  user_id: string;
  state: string;
  swept_at: number | null;
  generation: string | null;
};
type DeletingOwner = { user_id: string; email: string; operation_id: string };

const validSweepTime = (value: number | null): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/**
 * Control plane. One object, reached by name, that maps sign-in identities to users and
 * users to vault IDs. It creates each vault near its user, keeps the IDs so it can list
 * and delete them, and is never on the path of an everyday request.
 */
export class Directory extends DurableObject<Env> {
  // Only coalesces calls during this object's lifetime. The durable marker,
  // not this map, is the authority for deletion and crash recovery.
  private readonly initializing = new Map<string, { userId: string; promise: Promise<void> }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      migrateDirectory(this.ctx.storage.sql, (fn) => this.ctx.storage.transactionSync(fn), this.isGlobal, this.isShard);
      if (this.isGlobal && !this.sql.exec(`SELECT key FROM meta WHERE key='global_auth_guard' AND value='1'`).toArray().length)
        throw new AppError("unavailable", "sign-in coordinator requires review");
      if (this.isShard && !this.sql.exec(`SELECT key FROM meta WHERE key='shard_deletion_guard' AND value='1'`).toArray().length)
        throw new AppError("unavailable", "account deletion requires review");
      if (this.isShard && !this.sql.exec(`SELECT key FROM meta WHERE key='shard_auth_floor_guard' AND value='1'`).toArray().length)
        throw new AppError("unavailable", "sign-in coordinator requires review");
      if (this.isGlobal && !this.sql.exec(`SELECT key FROM meta WHERE key='global_shard_release_v3_guard' AND value='1'`).toArray().length)
        throw new AppError("unavailable", "account deletion requires review");
      if (this.isShard) await this.installShardRolloutBarrier();
    });
  }

  private get isGlobal(): boolean {
    return this.ctx.id.equals(this.env.DIRECTORY.idFromName("global"));
  }

  private get isShard(): boolean {
    for (let shard = 0; shard < 16; shard++)
      if (this.ctx.id.equals(this.env.DIRECTORY.idFromName(`directory-${shard}`))) return true;
    return false;
  }

  /** A shard receipt alone never authorizes removal of an invitation. */
  async sealInviteInventory(operation: string, email: string, excludedUserId: string, epoch: number): Promise<ShardInviteInventory> {
    if (!this.isShard) throw new AppError("invalid", "invitation inventory requires a shard");
    return new InviteInventory(this.sql, (fn) => this.ctx.storage.transactionSync(fn), () => this.readShardAuthFloor(),
      (userId) => this.ctx.id.equals(this.env.DIRECTORY.idFromName(directoryNameForUser(userId))))
      .seal(operation, email, excludedUserId, epoch);
  }

  /** Versioned target proof: older shards cannot silently ignore its tuple. */
  async sealInviteInventoryV2(operation: string, email: string, excludedUserId: string, epoch: number, target: InviteTarget): Promise<ShardInviteInventory> {
    if (!this.isShard || !target || typeof target !== "object" || Array.isArray(target))
      throw new AppError("invalid", "invitation inventory requires a shard target");
    return new InviteInventory(this.sql, (fn) => this.ctx.storage.transactionSync(fn), () => this.readShardAuthFloor(),
      (userId) => this.ctx.id.equals(this.env.DIRECTORY.idFromName(directoryNameForUser(userId))))
      .seal(operation, email, excludedUserId, epoch, target);
  }

  private get inviteRevocation(): InviteRevocation {
    return new InviteRevocation({
      sql: this.sql,
      storage: this.ctx.storage,
      transaction: (fn) => this.ctx.storage.transactionSync(fn),
      fingerprint: (operation, email) => this.inviteFingerprint(operation, email),
      verifyRollout: () => {
        if (!this.isGlobal || !this.inviteInventoryEnabled() ||
            (this.env as Env & { INVITE_REVOCATION_DRAIN_VERIFIED?: string }).INVITE_REVOCATION_DRAIN_VERIFIED !== "verified-v2")
          throw new AppError("unavailable", "invitation revocation rollout requires verification");
      },
      seal: (claim) => directoryByName(this.env, `directory-${claim.shard}`).sealShardInviteClaimV2(claim),
      close: (claim) => directoryByName(this.env, `directory-${claim.shard}`).closeShardInviteClaimV2(claim),
      removeInvite: (email, generation) => this.deleteInvite(email, generation),
    });
  }

  private async inviteFingerprint(operation: string, email: string): Promise<string> {
    if (!this.env.SESSION_KEY) throw new AppError("unavailable", "invitation revocation requires review");
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", encoder.encode(this.env.SESSION_KEY), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(JSON.stringify(["invite-revocation-v1", operation, email])));
    return Array.from(new Uint8Array(mac), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  async revokeInviteV3(email: string, operation: string): Promise<InviteRevocationStatus> {
    if (!this.isGlobal) throw new AppError("invalid", "invitation revocation requires the coordinator");
    const started = await this.inviteRevocation.begin(email, operation);
    if (started.state === "complete") return started;
    if (this.inviteRevocation.activeOperation(operation)) await this.inviteRevocation.resume();
    return this.inviteRevocation.status(operation);
  }

  async inviteRevocationStatus(operation: string): Promise<InviteRevocationStatus> {
    if (!this.isGlobal) throw new AppError("invalid", "invitation revocation requires the coordinator");
    return this.inviteRevocation.status(operation);
  }

  async listInviteRevocations(after: string | null = null, limit = 25): Promise<ReturnType<InviteRevocation["listPending"]>> {
    if (!this.isGlobal) throw new AppError("invalid", "invitation revocation requires the coordinator");
    return this.inviteRevocation.listPending(after, limit);
  }

  /** Versioned, read-only view of accounts in one pending revocation. */
  async inspectInviteRevocationAccountsV1(operation: string, after: string | null = null, limit = 25) {
    if (!this.isGlobal) throw new AppError("invalid", "invitation revocation requires the coordinator");
    return new InviteOrphanInspection({
      sql: this.sql,
      transaction: (fn) => this.ctx.storage.transactionSync(fn),
      status: (id) => this.inviteRevocation.status(id),
      fingerprint: (id, email) => this.inviteFingerprint(id, email),
      validVault: (id) => { try { return this.env.VAULT.idFromString(id).toString() === id; } catch { return false; } },
      inspectShard: (claim) => directoryByName(this.env, `directory-${claim.shard}`).inspectShardInviteClaimV3(claim),
    }).inspect(operation, after, limit);
  }

  private get shardClaimRevocation(): ShardClaimRevocation {
    return new ShardClaimRevocation(this.sql, (fn) => this.ctx.storage.transactionSync(fn),
      (shard, userId) => this.ctx.id.equals(this.env.DIRECTORY.idFromName(`directory-${shard}`)) &&
        (!userId || directoryNameForUser(userId) === `directory-${shard}`));
  }

  async sealShardInviteClaimV2(claim: RevokedShardClaim): Promise<ShardClaimSeal> {
    if (!this.isShard) throw new AppError("invalid", "invitation claim requires a shard");
    return this.shardClaimRevocation.seal(claim);
  }

  /** Versioned read: older shards cannot pretend to verify the full tuple. */
  async inspectShardInviteClaimV3(claim: RevokedShardClaim): Promise<ShardClaimObservation> {
    if (!this.isShard) throw new AppError("invalid", "invitation claim requires a shard");
    return this.shardClaimRevocation.inspect(claim);
  }

  async closeShardInviteClaimV2(claim: RevokedShardClaim): Promise<void> {
    if (!this.isShard) throw new AppError("invalid", "invitation claim requires a shard");
    return this.shardClaimRevocation.close(claim);
  }

  async closeInviteInventory(operation: string, sealEpoch: number, closeEpoch: number): Promise<void> {
    if (!this.isShard) throw new AppError("invalid", "invitation inventory requires a shard");
    new InviteInventory(this.sql, (fn) => this.ctx.storage.transactionSync(fn), () => this.readShardAuthFloor(),
      (userId) => this.ctx.id.equals(this.env.DIRECTORY.idFromName(directoryNameForUser(userId))))
      .close(operation, sealEpoch, closeEpoch);
  }

  async googleAuthEpoch(): Promise<number> {
    if (!this.isGlobal) throw new AppError("invalid", "sign-in coordinator is invalid");
    if (this.inviteCoordinator.active()) throw new AppError("unavailable", "sign-in is temporarily unavailable");
    // Progress bounded recovery opportunistically. An unresolved scan still
    // fences new or unbound identities while existing bound users may sign in.
    try { await this.inviteRevocation.rescanLegacyBatch(); } catch { /* Pending operator review. */ }
    return this.readGoogleAuthEpoch();
  }

  /** A persistent global rollout boundary, never supplied by the caller. */
  async googleShardRolloutEpoch(): Promise<number> {
    if (!this.isGlobal) throw new AppError("invalid", "sign-in coordinator is invalid");
    const row = this.sql.exec<{ epoch: number }>(`SELECT epoch FROM shard_rollout_barrier WHERE slot=1`).toArray()[0];
    if (!row || !Number.isSafeInteger(row.epoch) || row.epoch <= 0 || row.epoch > this.readGoogleAuthEpoch())
      throw new AppError("unavailable", "sign-in coordinator requires review");
    return row.epoch;
  }

  private readGoogleAuthEpoch(): number {
    const text = this.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='global_auth_epoch'`).toArray()[0]?.value;
    const epoch = Number(text);
    if (typeof text !== "string" || !/^(?:0|[1-9]\d*)$/.test(text) || !Number.isSafeInteger(epoch))
      throw new AppError("unavailable", "sign-in coordinator requires review");
    return epoch;
  }

  private readShardAuthFloor(): number {
    const text = this.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='shard_auth_floor'`).toArray()[0]?.value;
    const floor = Number(text);
    if (typeof text !== "string" || !/^(?:0|[1-9]\d*)$/.test(text) || !Number.isSafeInteger(floor))
      throw new AppError("unavailable", "sign-in coordinator requires review");
    return floor;
  }

  private async installShardRolloutBarrier(): Promise<void> {
    const installed = this.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='shard_rollout_epoch'`).toArray()[0]?.value;
    if (installed !== undefined) {
      if (!/^[1-9]\d*$/.test(installed) || !Number.isSafeInteger(Number(installed)) || this.readShardAuthFloor() < Number(installed))
        throw new AppError("unavailable", "sign-in coordinator requires review");
      return;
    }
    // An older deletion may have finished without advancing the epoch, so a
    // fresh floor of zero is not safe. Input gating keeps the shard closed
    // until the coordinator's migration barrier is durably installed.
    const barrier = await directory(this.env).googleShardRolloutEpoch();
    if (!Number.isSafeInteger(barrier) || barrier <= 0)
      throw new AppError("unavailable", "sign-in coordinator requires review");
    this.ctx.storage.transactionSync(() => {
      const floor = Math.max(this.readShardAuthFloor(), barrier);
      this.sql.exec(`UPDATE meta SET value=? WHERE key='shard_auth_floor'`, String(floor));
      this.sql.exec(`INSERT INTO meta(key,value) VALUES ('shard_rollout_epoch',?)`, String(barrier));
    });
  }

  /** The check and authorized writes share one non-interleaving SQL transaction. */
  private googleWrite<T>(provider: string, epoch: number | undefined, action: () => T): T {
    return this.ctx.storage.transactionSync(() => {
      if (this.isGlobal && (provider === "google" || this.sql.exec(`SELECT key FROM meta WHERE key='invite_inventory_epoch_guard' AND value='1'`).toArray().length > 0)) {
        const text = this.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='global_auth_epoch'`).one().value;
        if (!Number.isSafeInteger(epoch) || epoch! < 0 || !/^(?:0|[1-9]\d*)$/.test(text) || Number(text) !== epoch)
          throw new AppError("conflict", "sign-in is stale; try again");
        this.sql.exec(`INSERT INTO global_auth_marker(slot,epoch) VALUES (1,?)`, epoch!);
        try { return action(); } finally { this.sql.exec(`DELETE FROM global_auth_marker WHERE slot=1`); }
      }
      if (this.isShard && (provider === "google" || this.sql.exec(`SELECT key FROM meta WHERE key='shard_invite_epoch_guard' AND value='1'`).toArray().length > 0)) {
        if (!Number.isSafeInteger(epoch) || epoch! < this.readShardAuthFloor())
          throw new AppError("conflict", "sign-in is stale; try again");
        this.sql.exec(`INSERT INTO shard_auth_marker(slot,epoch) VALUES (1,?)`, epoch!);
        try { return action(); } finally { this.sql.exec(`DELETE FROM shard_auth_marker WHERE slot=1`); }
      }
      return action();
    });
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
  }

  private inviteInventoryEnabled(): boolean {
    // Operator assertion, not proof: enable only after an independently
    // verified drain of older coordinator and shard runtimes.
    return (this.env as Env & { INVITE_INVENTORY_DRAIN_VERIFIED?: string }).INVITE_INVENTORY_DRAIN_VERIFIED === "verified-v1";
  }

  private requireInventoryOwner(b: InventoryIdentity): void {
    if (!this.isGlobal) throw new AppError("unavailable", "account deletion changed; retry cleanup");
    if (directoryNameForUser(b.userId) !== "global") {
      // The coordinator can establish the immutable account claim locally.
      // The target shard independently proves and fences the finalization.
      if (!boundShardInviteClaim(this.sql, b.userId, b.email))
        throw new AppError("unavailable", "invitation binding requires review");
      return;
    }
    if (!this.sql.exec(
      `SELECT v.vault_id FROM vaults v JOIN users u ON u.user_id=v.user_id
       JOIN account_final_sweeps a ON a.vault_id=v.vault_id AND a.user_id=u.user_id
       JOIN account_invite_deletions i ON i.vault_id=v.vault_id AND i.user_id=u.user_id
       WHERE v.vault_id=? AND v.user_id=? AND u.email=? AND u.state='deleting' AND v.state='swept'
       AND v.swept_at=a.swept_at AND a.generation=? AND a.phase='destroyed' AND a.invite_closed=0 AND i.operation_id=?`,
      b.vaultId, b.userId, b.email, b.finalGeneration, b.operationId,
    ).toArray().length || this.sql.exec(`SELECT vault_id FROM retired_vaults WHERE user_id=? OR vault_id=?`, b.userId, b.vaultId).toArray().length)
      throw new AppError("unavailable", "account deletion changed; retry cleanup");
  }

  private get inviteCoordinator(): InviteCoordinator {
    return new InviteCoordinator({
      sql: this.sql,
      transaction: (fn) => this.ctx.storage.transactionSync(fn),
      storage: this.ctx.storage,
      epoch: () => this.readGoogleAuthEpoch(),
      seal: (shard, b, attempt, epoch) => {
        const stub = directoryByName(this.env, `directory-${shard}`);
        if (directoryNameForUser(b.userId) !== `directory-${shard}`)
          return stub.sealInviteInventory(attempt, b.email, b.userId, epoch);
        // The barrier freezes both the global home and claim while the RPC is
        // outstanding. Never accept caller-supplied claim details as proof.
        const claim = boundShardInviteClaim(this.sql, b.userId, b.email);
        if (!claim) throw new AppError("unavailable", "invitation binding requires review");
        return stub.sealInviteInventoryV2(attempt, b.email, b.userId, epoch, {
          ...b, claimToken: claim.token, generation: claim.generation, provider: claim.provider, subject: claim.subject,
        });
      },
      close: (shard, operation, sealEpoch, closeEpoch) => directoryByName(this.env, `directory-${shard}`).closeInviteInventory(operation, sealEpoch, closeEpoch),
      validate: (b) => {
        if (!this.inviteInventoryEnabled()) throw new AppError("unavailable", "invitation inventory rollout requires verification");
        this.requireInventoryOwner(b);
      },
      decide: (b, otherUsers) => {
        if (!this.inviteInventoryEnabled()) throw new AppError("unavailable", "invitation inventory rollout requires verification");
        this.requireInventoryOwner(b);
        const receipt = this.sql.exec<{ generation: string | null; binding_verified: number }>(
          `SELECT generation,binding_verified FROM invite_deletion_receipts WHERE operation_id=? AND user_id=? AND vault_id=? AND email=? AND state='captured'`,
          b.operationId, b.userId, b.vaultId, b.email,
        ).toArray()[0];
        const binding = directoryNameForUser(b.userId) === "global"
          ? this.sql.exec<{ email: string; generation: string | null }>(
              `SELECT email,generation FROM account_invite_bindings WHERE user_id=?`, b.userId,
            ).toArray()[0]
          : boundShardInviteClaim(this.sql, b.userId, b.email);
        if (!receipt || receipt.binding_verified !== 1 || !binding || binding.email !== b.email || binding.generation !== receipt.generation)
          throw new AppError("unavailable", "invitation binding requires review");
        if (receipt.generation && otherUsers === 0 && !this.hasOtherLocalInviteUser(b.userId, b.email))
          this.deleteInvite(b.email, receipt.generation);
      },
      finish: (b) => {
        // Once every shard is closed, a changed finalization must not hold the
        // global sign-in barrier indefinitely. Leave its receipt pending for
        // reconciliation; the decision was separately checked before removal.
        try { this.requireInventoryOwner(b); } catch { return; }
        this.sql.exec(
          `UPDATE invite_deletion_receipts SET state='removed' WHERE operation_id=? AND user_id=? AND vault_id=? AND email=? AND state='captured'`,
          b.operationId, b.userId, b.vaultId, b.email,
        );
      },
    });
  }

  private get placement(): PlacementFence {
    return new PlacementFence(this.sql, (fn) => this.ctx.storage.transactionSync(fn));
  }

  private get billing(): BillingStore {
    return new BillingStore(this.sql, this.env, {
      transaction: (fn) => this.ctx.storage.transactionSync(fn),
      account: (userId) => {
        const row = this.sql
          .exec<{ vault_id: string }>(
            `SELECT v.vault_id FROM vaults v JOIN users u ON v.user_id=u.user_id WHERE u.user_id=? AND u.state='active' AND v.state='active'`,
            userId,
          )
          .toArray()[0];
        return row ? { vaultId: row.vault_id } : null;
      },
      deliver: (vaultId, revision, plan) =>
        this.env.VAULT.get(this.env.VAULT.idFromString(vaultId)).setPlan(
          revision,
          plan,
        ),
    });
  }
  private get operatorSpend(): OperatorSpendStore {
    return new OperatorSpendStore(this.sql, (fn) => this.ctx.storage.transactionSync(fn), this.isGlobal);
  }

  /** Reserves an operator job's model call, such as a taxonomy index build's, before it is sent. Only the global Directory keeps these. */
  async reserveOperatorModelAttempt(runId: string, step: string, attempt: ModelAttempt, maxCostMicros: number, dailyCapMicros: number): Promise<void> {
    this.operatorSpend.reserve(runId, step, attempt, maxCostMicros, dailyCapMicros);
  }

  /** Settles an operator job's model call. A null cost keeps it counted at its reservation. */
  async settleOperatorModelAttempt(id: string, costMicros: number | null, inputTokens: number | null, outputTokens: number | null): Promise<void> {
    this.operatorSpend.settle(id, costMicros, inputTokens, outputTokens);
  }

  async acceptBillingEvent(event: BillingEvent, userId?: string): Promise<void> {
    this.billing.accept(userId, event);
    if (this.billing.pending()) await this.scheduleAt(Date.now());
  }

  /**
   * Finds or creates the user and their vault. Rows are written before the first await, so a
   * second sign-in racing the first finds them and gets the same vault. Safe to repeat.
   */
  async signIn(p: SignInInput): Promise<{ userId: string; vaultId: string; created?: boolean; shardClaimToken?: string | null; shardInviteClaim?: ShardInviteClaim | null }> {
    if (p.shardInviteClaim !== undefined) throw new AppError("invalid", "invalid account placement claim");
    return this.signInCore(p, false);
  }

  /** Versioned target call: an older shard cannot silently ignore the binding. */
  async signInWithInviteClaim(p: SignInInput): Promise<{ userId: string; vaultId: string; created?: boolean; shardClaimToken?: string | null; shardInviteClaim?: ShardInviteClaim | null }> {
    if (p.provider !== "google" || !this.isShard || p.homeShard === undefined ||
        !this.ctx.id.equals(this.env.DIRECTORY.idFromName(`directory-${p.homeShard}`)))
      throw new AppError("invalid", "invalid account placement claim");
    if (p.shardInviteClaim !== undefined && (!validShardInviteClaim(p.shardInviteClaim) ||
        p.shardInviteClaim.token !== p.shardClaimToken || p.shardInviteClaim.email !== p.email.trim().toLowerCase()))
      throw new AppError("invalid", "invalid account placement claim");
    return this.signInCore(p, true);
  }

  /** Versioned creation so a migrated shard fences late revoked claims. */
  async signInWithInviteClaimV2(p: SignInInput): Promise<{ userId: string; vaultId: string; created?: boolean; shardClaimToken?: string | null; shardInviteClaim?: ShardInviteClaim | null }> {
    if (p.provider !== "google" || !this.isShard || p.homeShard === undefined ||
        !this.ctx.id.equals(this.env.DIRECTORY.idFromName(`directory-${p.homeShard}`)))
      throw new AppError("invalid", "invalid account placement claim");
    if (p.shardInviteClaim !== undefined && (!validShardInviteClaim(p.shardInviteClaim) ||
        p.shardInviteClaim.token !== p.shardClaimToken || p.shardInviteClaim.email !== p.email.trim().toLowerCase()))
      throw new AppError("invalid", "invalid account placement claim");
    return this.signInCore(p, true, true);
  }

  private async signInCore(p: SignInInput, inviteClaimV3: boolean, revocationSafe = false): Promise<{ userId: string; vaultId: string; created?: boolean; shardClaimToken?: string | null; shardInviteClaim?: ShardInviteClaim | null }> {
    if (p.authExpiryMs !== undefined) requireFreshAuth(p.authExpiryMs);
    if (this.isShard && p.shardInviteClaim) this.shardClaimRevocation.assertOpen(p.shardInviteClaim.token);
    if (p.shardClaimToken !== undefined &&
        (p.provider !== "google" || !Number.isInteger(p.homeShard) || p.homeShard! < 0 || p.homeShard! > 15 ||
          !this.ctx.id.equals(this.env.DIRECTORY.idFromName(`directory-${p.homeShard}`)) || typeof p.shardClaimToken !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(p.shardClaimToken)))
      throw new AppError("invalid", "invalid account placement claim");
    // Existing identities also need the original authorization epoch: a
    // stale callback must not attach to a replacement account after erasure.
    const inventoryEpochRequired = this.isGlobal
      ? this.sql.exec(`SELECT key FROM meta WHERE key='invite_inventory_epoch_guard' AND value='1'`).toArray().length > 0
      : this.isShard && this.sql.exec(`SELECT key FROM meta WHERE key='shard_invite_epoch_guard' AND value='1'`).toArray().length > 0;
    if ((this.isGlobal || this.isShard) && (p.provider === "google" || inventoryEpochRequired))
      this.googleWrite(p.provider, p.authEpoch, () => {});
    const assertGlobalOrphanOpen = (): void => {
      if (this.isGlobal && p.provider === "google" && this.sql.exec(`SELECT user_id FROM invite_revocation_global_orphans
          WHERE provider=? AND subject=?`, p.provider, p.subject).toArray().length)
        throw new AppError("unavailable", "account invitation requires review");
    };
    assertGlobalOrphanOpen();
    const email = p.email.trim().toLowerCase();
    let row = this.findAccount(p.provider, p.subject);
    const assertLegacyBound = (userId?: string): void => {
      if (!this.isGlobal || p.provider !== "google" || !this.inviteRevocation.hasLegacy()) return;
      const bound = userId && this.sql.exec(`SELECT user_id FROM identity_homes
        WHERE provider=? AND subject=? AND shard IS NULL AND user_id=? AND placement_state='open' AND generation IS NULL`,
        p.provider, p.subject, userId).toArray().length;
      if (!bound) throw new AppError("unavailable", "invitation inventory requires review");
    };
    assertLegacyBound(row?.user_id);
    let created = false;
    const storedShardClaim = (userId: string) => this.sql.exec<{ token: string }>(
      `SELECT token FROM shard_identity_claim_tokens WHERE provider=? AND subject=? AND user_id=?`, p.provider, p.subject, userId,
    ).toArray()[0]?.token ?? null;
    // Legacy RPC callers may omit the claim even for a tokenized identity.
    // Check its persisted token before any Vault I/O, irrespective of the
    // caller's RPC version, so a quarantined account cannot be reinitialized.
    const assertStoredShardClaimOpen = (userId: string): void => {
      if (!this.isShard || p.provider !== "google") return;
      const token = storedShardClaim(userId);
      // Preserve the caller-visible conflict for a supplied claim that no
      // longer matches; an absent claim still cannot bypass a sealed binding.
      if (p.shardClaimToken && p.shardClaimToken !== token)
        throw new AppError("conflict", "account placement changed; retry sign-in");
      const binding = this.sql.exec<{ provider: string; subject: string; token: string }>(
        `SELECT provider,subject,token FROM shard_invite_account_bindings WHERE user_id=?`, userId,
      ).toArray()[0];
      // New bindings must have the same token in both tables. A missing or
      // inconsistent token is not evidence that an old caller is unsealed.
      if (binding && (binding.provider !== p.provider || binding.subject !== p.subject || binding.token !== token))
        throw new AppError("unavailable", "account invitation requires review");
      if (token) this.shardClaimRevocation.assertOpen(token);
    };
    if (row) assertStoredShardClaimOpen(row.user_id);
    // Do not initialize a vault for an already-known conflicting generation.
    // The check below is repeated after initialization because that I/O yields.
    if (row && p.shardClaimToken) {
      const existingClaim = storedShardClaim(row.user_id);
      if (existingClaim !== p.shardClaimToken)
        throw new AppError("conflict", "account placement changed; retry sign-in");
    }
    const attempt = p.placementAttempt;
    if (attempt && (!syntheticPlacementIdentity(p.provider, p.subject) || email !== p.subject.toLowerCase()))
      throw new AppError("unavailable", "placement fencing is restricted to synthetic identities");
    if (attempt && attempt.shard !== (p.homeShard ?? null))
      throw new AppError("invalid", "placement target changed");
    const receipt = attempt ? this.placement.receipt(attempt.id) : null;
    if (receipt && (!row || receipt.state !== "accepted" || receipt.generation !== attempt?.generation || receipt.user_id !== row.user_id))
      throw new AppError("conflict", "placement attempt was closed");
    // Routing and this RPC are separate operations. If erasure removed the
    // observed account in between, retry routing instead of recreating it on
    // a potentially stale shard alongside a new account elsewhere.
    if (p.expectedUserId !== undefined && (!row || row.user_id !== p.expectedUserId))
      throw new AppError("conflict", "the account changed; retry sign-in");
    if (!row) {
      if (inviteClaimV3 && !p.shardInviteClaim)
        throw new AppError("unavailable", "account invitation requires review");
      // The disposable test namespace remains fenced even after opt-out, so
      // a delayed unregistered call cannot recreate an experimental account.
      if (syntheticPlacementIdentity(p.provider, p.subject) && !attempt)
        throw new AppError("unavailable", "account creation requires a registered placement attempt");
      // Test sign-ins exist only on staging, behind TEST_SIGNIN_KEY, so the end-to-end check needs no invite.
      if (
        p.provider !== "test" &&
        this.env.INVITE_ONLY !== "false" &&
        // A global-home account can validate and create inside this object's
        // input gate. A routed authorization may have become stale while a
        // prior account was erased, so do not trust it on this path. Sharded
        // homes still need the separately validated control-plane decision.
        (p.homeShard === undefined || !p.inviteAuthorized) &&
        !this.isInvited(email)
      ) {
        throw new AppError(
          "forbidden",
          "this email has not been invited to the beta yet",
        );
      }
      const vaultId = this.env.VAULT.newUniqueId().toString();
      const userId =
        p.homeShard === undefined
          ? crypto.randomUUID()
          : shardedUserId(p.homeShard);
      const now = Date.now();
      this.googleWrite(p.provider, p.authEpoch, () => {
        const claimToken = revocationSafe ? p.shardInviteClaim?.token : undefined;
        if (claimToken) this.shardClaimRevocation.beginCreate(p.provider, p.subject, userId, claimToken);
        try {
        this.sql.exec(
          `INSERT INTO users (user_id, email, state, created_at) VALUES (?, ?, 'active', ?)`,
          userId,
          email,
          now,
        );
        if (this.isGlobal) {
          // Record even the absence of a grant. This is in the same
          // transaction as the user insert and uses sign-in's normalized
          // email, so a later reissue is never adopted by account deletion.
          const grant = this.sql.exec<{ generation: string | null }>(
            `SELECT generation FROM invites WHERE email=?`, email,
          ).toArray()[0];
          if (grant && (typeof grant.generation !== "string" || !/^[a-f0-9]{32}$/.test(grant.generation)))
            throw new AppError("unavailable", "invitation requires review");
          this.sql.exec(`INSERT INTO account_invite_bindings(user_id,email,generation) VALUES (?,?,?)`,
            userId, email, grant?.generation ?? null);
        }
        this.sql.exec(
          `INSERT INTO identities (provider, subject, user_id) VALUES (?, ?, ?)`,
          p.provider,
          p.subject,
          userId,
        );
        if (p.shardClaimToken)
          this.sql.exec(`INSERT INTO shard_identity_claim_tokens (provider,subject,user_id,token) VALUES (?,?,?,?)`, p.provider, p.subject, userId, p.shardClaimToken);
        if (inviteClaimV3 && p.shardInviteClaim)
          this.sql.exec(`INSERT INTO shard_invite_account_bindings(user_id,provider,subject,token,email,generation) VALUES (?,?,?,?,?,?)`,
            userId, p.provider, p.subject, p.shardInviteClaim.token, p.shardInviteClaim.email, p.shardInviteClaim.generation);
        if (attempt) {
          this.sql.exec(`INSERT INTO placement_identities(provider,subject,generation,user_id) VALUES (?,?,?,?)`, p.provider, p.subject, attempt.generation, userId);
          this.placement.accept(attempt, userId);
        }
        this.sql.exec(
          `INSERT INTO vaults (vault_id, user_id, hint, state, updated_at) VALUES (?, ?, ?, 'creating', ?)`,
          vaultId,
          userId,
          p.hint,
          now,
        );
        } finally {
          if (claimToken) this.shardClaimRevocation.endCreate(p.provider, p.subject, userId);
        }
      });
      created = true;
      row = this.findAccount(p.provider, p.subject)!;
    }
    if (row.user_state !== "active")
      throw new AppError("forbidden", "this account is being deleted");
    if (attempt && !receipt) {
      this.ctx.storage.transactionSync(() => {
        const identity = this.sql.exec<{ generation: string; user_id: string }>(`SELECT generation,user_id FROM placement_identities WHERE provider=? AND subject=?`, p.provider, p.subject).toArray()[0];
        if (!identity || identity.generation !== attempt.generation || identity.user_id !== row!.user_id)
          throw new AppError("unavailable", "legacy account placement requires review");
        this.placement.accept(attempt, row!.user_id);
      });
    }
    if (row.vault_state === "creating") {
      // Only the first get() of an object honours a location hint, so the vault is placed near the user now.
      await this.initializeVault(row.vault_id, row.user_id, row.hint);
      assertLegacyBound(row.user_id);
      assertGlobalOrphanOpen();
      // A token may be sealed during the cross-object call. Do not publish an
      // active shard mapping when the account is already quarantined.
      assertStoredShardClaimOpen(row.user_id);
      this.sql.exec(
        `UPDATE vaults SET state = 'active', updated_at = ? WHERE vault_id = ? AND user_id = ? AND state = 'creating'
         AND EXISTS(SELECT 1 FROM users WHERE user_id=? AND state='active')
         AND EXISTS(SELECT 1 FROM identities WHERE provider=? AND subject=? AND user_id=?)`,
        Date.now(),
        row.vault_id,
        row.user_id,
        row.user_id,
        p.provider,
        p.subject,
        row.user_id,
      );
    }
    // Deletion can begin while init is awaiting a different Durable Object.
    const current = this.findAccount(p.provider, p.subject);
    if (
      !current || current.user_state !== "active" || current.user_id !== row.user_id ||
      current.vault_state !== "active" || current.vault_id !== row.vault_id
    )
      throw new AppError("forbidden", "this account is being deleted");
    if (p.authExpiryMs !== undefined) requireFreshAuth(p.authExpiryMs);
    assertLegacyBound(row.user_id);
    assertGlobalOrphanOpen();
    const shardClaimToken = storedShardClaim(row.user_id);
    // The seal may have arrived while initialization was in flight. Older
    // RPCs omit the claim input, so check the persisted token again for all
    // Google shard callers before returning an account.
    assertStoredShardClaimOpen(row.user_id);
    if (p.shardClaimToken && p.shardClaimToken !== shardClaimToken)
      throw new AppError("conflict", "account placement changed; retry sign-in");
    let shardInviteClaim: ShardInviteClaim | null = null;
    if (inviteClaimV3) {
      const binding = this.sql.exec<{ provider: string; subject: string; token: string; email: string; generation: string | null }>(
        `SELECT provider,subject,token,email,generation FROM shard_invite_account_bindings WHERE user_id=?`, row.user_id,
      ).toArray()[0];
      if (binding) {
        shardInviteClaim = { token: binding.token, email: binding.email, generation: binding.generation };
        this.shardClaimRevocation.assertOpen(binding.token);
        const storedEmail = this.sql.exec<{ email: string }>(`SELECT email FROM users WHERE user_id=?`, row.user_id).toArray()[0]?.email;
        if (!validShardInviteClaim(shardInviteClaim) || binding.provider !== p.provider || binding.subject !== p.subject ||
            storedEmail !== binding.email || p.email.trim().toLowerCase() !== binding.email || shardClaimToken !== binding.token ||
            (p.shardInviteClaim && (p.shardInviteClaim.token !== binding.token || p.shardInviteClaim.email !== binding.email ||
              p.shardInviteClaim.generation !== binding.generation)))
          throw new AppError("unavailable", "account invitation requires review");
      } else if (p.shardInviteClaim) throw new AppError("unavailable", "account invitation requires review");
    }
    return { userId: row.user_id, vaultId: row.vault_id, ...(p.reportCreation ? { created, shardClaimToken, ...(inviteClaimV3 ? { shardInviteClaim } : {}) } : {}) };
  }

  /** A marker precedes cross-object init and survives an uncertain outcome. */
  private async initializeVault(vaultId: string, userId: string, hint?: string): Promise<void> {
    const ongoing = this.initializing.get(vaultId);
    if (ongoing) {
      if (ongoing.userId !== userId)
        throw new AppError("conflict", "vault initialization owner changed");
      return await ongoing.promise;
    }
    // Recovery is allowed only for the owner and vault already recorded by
    // the Directory. No new identifier or owner may be supplied by a retry.
    const recorded = this.sql.exec<{ user_id: string }>(
      `SELECT user_id FROM vaults WHERE vault_id = ? AND state = 'creating'
       UNION SELECT user_id FROM vault_replacements WHERE target_id = ? AND state = 'preparing'`,
      vaultId, vaultId,
    ).toArray();
    if (recorded.length !== 1 || recorded[0]!.user_id !== userId)
      throw new AppError("conflict", "vault initialization identity changed");
    const existing = this.sql.exec(`SELECT vault_id FROM vault_initializations WHERE vault_id = ?`, vaultId).toArray().length > 0;
    if (existing) {
      // The earlier request may still arrive. Persist this before retrying;
      // neither this acknowledgement nor an earlier one may remove it.
      this.sql.exec(`UPDATE vault_initializations SET sticky = 1 WHERE vault_id = ?`, vaultId);
    } else {
      this.sql.exec(`INSERT INTO vault_initializations (vault_id, sticky) VALUES (?, 0)`, vaultId);
    }
    const promise = (async () => {
      const id = this.env.VAULT.idFromString(vaultId);
      const stub = hint
        ? this.env.VAULT.get(id, { locationHint: hint as DurableObjectLocationHint })
        : this.env.VAULT.get(id);
      // An exception, including an interrupted acknowledgement, cannot establish
      // that init did not run or cannot arrive later. Keep the marker in that case.
      await stub.init(userId);
      // A successful first attempt can settle its own marker. A recovery
      // attempt cannot prove the outcome of any earlier attempt.
      this.sql.exec(`DELETE FROM vault_initializations WHERE vault_id = ? AND sticky = 0`, vaultId);
    })();
    this.initializing.set(vaultId, { userId, promise });
    try {
      await promise;
    } finally {
      if (this.initializing.get(vaultId)?.promise === promise)
        this.initializing.delete(vaultId);
    }
  }

  private requireInitializationSettled(vaultId: string): void {
    if (this.sql.exec(`SELECT vault_id FROM vault_initializations WHERE vault_id = ?`, vaultId).toArray().length)
      throw new AppError("unavailable", "vault initialization is unresolved");
  }

  async existingIdentity(
    provider: string,
    subject: string,
  ): Promise<{ userId: string; vaultId: string } | null> {
    const row = this.findAccount(provider, subject);
    return row ? { userId: row.user_id, vaultId: row.vault_id } : null;
  }
  async requireInvite(email: string): Promise<void> {
    if (
      this.env.INVITE_ONLY !== "false" &&
      !this.isInvited(email.trim().toLowerCase())
    )
      throw new AppError(
        "forbidden",
        "this email has not been invited to the beta yet",
      );
  }
  async claimIdentityHome(
    provider: string,
    subject: string,
    preferredShard: number | null,
    email?: string,
    authExpiryMs?: number,
    authEpoch?: number,
  ): Promise<number | null> {
    if (authExpiryMs !== undefined) requireFreshAuth(authExpiryMs);
    if (
      preferredShard !== null &&
      (!Number.isInteger(preferredShard) ||
        preferredShard < 0 ||
        preferredShard > 15)
    )
      throw new AppError("invalid", "invalid directory shard");
    // Check the invitation in the same input-gated operation as the claim.
    // A prior Worker check can outlive deletion and invite revocation. Older
    // Workers that do not supply an email fail closed for new invited users.
    if (provider !== "test" && this.env.INVITE_ONLY !== "false") {
      if (typeof email !== "string" || !email.trim())
        throw new AppError("unavailable", "sign-in service is updating; try again");
      if (!this.isInvited(email.trim().toLowerCase()))
        throw new AppError("forbidden", "this email has not been invited to the beta yet");
    }
    return this.googleWrite(provider, authEpoch, () => {
      this.sql.exec(
        `INSERT OR IGNORE INTO identity_homes (provider,subject,shard) VALUES (?,?,?)`,
        provider,
        subject,
        preferredShard,
      );
      return this.sql
        .exec<{ shard: number | null }>(
          `SELECT shard FROM identity_homes WHERE provider=? AND subject=?`,
          provider,
          subject,
        )
        .one().shard;
    });
  }
  /** Claim a new Google shard home with an opaque token recorded atomically. */
  async claimIdentityHomeV2(
    provider: string,
    subject: string,
    preferredShard: number | null,
    email?: string,
    authExpiryMs?: number,
    authEpoch?: number,
  ): Promise<{ shard: number | null; shardClaimToken: string | null }> {
    if (!this.isGlobal || provider !== "google") throw new AppError("invalid", "invalid account placement");
    if (authExpiryMs !== undefined) requireFreshAuth(authExpiryMs);
    if (preferredShard !== null && (!Number.isInteger(preferredShard) || preferredShard < 0 || preferredShard > 15))
      throw new AppError("invalid", "invalid directory shard");
    if (this.env.INVITE_ONLY !== "false") {
      if (typeof email !== "string" || !email.trim())
        throw new AppError("unavailable", "sign-in service is updating; try again");
      if (!this.isInvited(email.trim().toLowerCase()))
        throw new AppError("forbidden", "this email has not been invited to the beta yet");
    }
    return this.googleWrite(provider, authEpoch, () => {
      let home = this.sql.exec<{ shard: number | null; user_id: string | null; generation: string | null; placement_state: string }>(
        `SELECT shard,user_id,generation,placement_state FROM identity_homes WHERE provider=? AND subject=?`, provider, subject,
      ).toArray()[0];
      if (!home) {
        this.sql.exec(`INSERT INTO identity_homes(provider,subject,shard) VALUES (?,?,?)`, provider, subject, preferredShard);
        if (preferredShard !== null)
          this.sql.exec(`INSERT INTO shard_home_claim_tokens(provider,subject,token) VALUES (?,?,?)`, provider, subject, crypto.randomUUID());
        home = this.sql.exec<{ shard: number | null; user_id: string | null; generation: string | null; placement_state: string }>(
          `SELECT shard,user_id,generation,placement_state FROM identity_homes WHERE provider=? AND subject=?`, provider, subject,
        ).one();
      }
      if (home.generation || home.placement_state !== "open")
        throw new AppError("unavailable", "account placement requires review");
      const token = this.sql.exec<{ token: string }>(`SELECT token FROM shard_home_claim_tokens WHERE provider=? AND subject=?`, provider, subject).toArray()[0]?.token ?? null;
      // Minting a token after an older claim would not fence its in-flight calls.
      if (home.shard !== null && home.user_id === null && !token)
        throw new AppError("unavailable", "legacy account placement requires review");
      return { shard: home.shard, shardClaimToken: token };
    });
  }

  /** Capture a shard's invitation before any target creation is dispatched. */
  async claimIdentityHomeV3(provider: string, subject: string, preferredShard: number | null,
    email: string, authExpiryMs?: number, authEpoch?: number): Promise<{ shard: number | null; shardInviteClaim: ShardInviteClaim | null }> {
    if (!this.isGlobal || provider !== "google" || typeof email !== "string" || !email.trim() || email.length > 320 ||
        (preferredShard !== null && (!Number.isInteger(preferredShard) || preferredShard < 0 || preferredShard > 15)))
      throw new AppError("invalid", "invalid account placement");
    if (authExpiryMs !== undefined) requireFreshAuth(authExpiryMs);
    const normalized = email.trim().toLowerCase();
    return this.googleWrite(provider, authEpoch, () => {
      this.sql.exec(`INSERT INTO invite_registration_marker(slot,email) VALUES (1,?)`, normalized);
      try {
        if (this.env.INVITE_ONLY !== "false" && !this.isInvited(normalized))
          throw new AppError("forbidden", "this email has not been invited to the beta yet");
        let home = this.sql.exec<{ shard: number | null; user_id: string | null; generation: string | null; placement_state: string }>(
          `SELECT shard,user_id,generation,placement_state FROM identity_homes WHERE provider=? AND subject=?`, provider, subject,
        ).toArray()[0];
        if (!home) {
          this.sql.exec(`INSERT INTO identity_homes(provider,subject,shard) VALUES (?,?,?)`, provider, subject, preferredShard);
          if (preferredShard !== null) {
            const token = crypto.randomUUID();
            const grant = this.sql.exec<{ generation: string | null }>(`SELECT generation FROM invites WHERE email=?`, normalized).toArray()[0];
            const claim: ShardInviteClaim = { token, email: normalized, generation: grant?.generation ?? null };
            if (!validShardInviteClaim(claim) || (grant && grant.generation === null))
              throw new AppError("unavailable", "invitation requires review");
            this.sql.exec(`INSERT INTO shard_home_claim_tokens(provider,subject,token) VALUES (?,?,?)`, provider, subject, token);
            this.sql.exec(`INSERT INTO shard_home_invite_claims(provider,subject,token,email,generation) VALUES (?,?,?,?,?)`,
              provider, subject, token, normalized, claim.generation);
          }
          home = this.sql.exec<{ shard: number | null; user_id: string | null; generation: string | null; placement_state: string }>(
            `SELECT shard,user_id,generation,placement_state FROM identity_homes WHERE provider=? AND subject=?`, provider, subject,
          ).one();
        }
        if (home.generation || home.placement_state !== "open") throw new AppError("unavailable", "account placement requires review");
        if (home.shard === null) return { shard: null, shardInviteClaim: null };
        const row = this.sql.exec<{ token: string; email: string; generation: string | null; user_id: string | null }>(
          `SELECT token,email,generation,user_id FROM shard_home_invite_claims WHERE provider=? AND subject=?`, provider, subject,
        ).toArray()[0];
        const token = this.sql.exec<{ token: string }>(`SELECT token FROM shard_home_claim_tokens WHERE provider=? AND subject=?`, provider, subject).toArray()[0]?.token;
        if (!row) {
          if (home.user_id === null) throw new AppError("unavailable", "legacy account placement requires review");
          return { shard: home.shard, shardInviteClaim: null };
        }
        const claim: ShardInviteClaim = { token: row.token, email: row.email, generation: row.generation };
        if (!validShardInviteClaim(claim) || token !== claim.token || claim.email !== normalized || row.user_id !== home.user_id)
          throw new AppError("conflict", "account placement changed; retry sign-in");
        return { shard: home.shard, shardInviteClaim: claim };
      } finally {
        this.sql.exec(`DELETE FROM invite_registration_marker WHERE slot=1`);
      }
    });
  }
  async placementEpoch(): Promise<number> {
    return this.placement.epoch();
  }
  async reservePlacementAttempt(provider: string, subject: string, preferred: number | null, expectedEpoch: number): Promise<PlacementAttempt> {
    return this.placement.reserve(provider, subject, preferred, expectedEpoch);
  }
  async sealPlacementAttempt(attempt: PlacementAttempt): Promise<{ userId: string | null }> {
    return this.placement.seal(attempt);
  }
  async settlePlacementAttempt(provider: string, subject: string, attempt: PlacementAttempt, userId: string | null): Promise<void> {
    this.placement.settle(provider, subject, attempt, userId);
  }
  async closePlacementHome(provider: string, subject: string, generation: string, userId: string): Promise<PlacementAttempt[]> {
    return this.placement.close(provider, subject, generation, userId);
  }
  async releasePlacementHome(provider: string, subject: string, generation: string, userId: string): Promise<void> {
    this.placement.release(provider, subject, generation, userId);
  }
  /** Reconcile registered synthetic dispatches without assuming an absent RPC never arrives. */
  async reconcileSyntheticPlacement(provider: string, subject: string): Promise<{ remaining: number }> {
    const attempts = this.placement.pending(provider, subject);
    for (const attempt of attempts) {
      const target = attempt.shard === null ? directory(this.env) : directoryByName(this.env, `directory-${attempt.shard}`);
      const sealed = await target.sealPlacementAttempt(attempt);
      this.placement.settle(provider, subject, attempt, sealed.userId);
    }
    return { remaining: this.placement.pending(provider, subject).length };
  }
  async inspectSyntheticPlacement(provider: string, subject: string): Promise<ReturnType<PlacementFence["inspect"]>> {
    return this.placement.inspect(provider, subject);
  }
  /** Seal every registered attempt before releasing an unbound synthetic claim. */
  async cleanupSyntheticOrphan(provider: string, subject: string, generation: string): Promise<{ status: "released" | "account-present" }> {
    const started = this.placement.beginOrphanCleanup(provider, subject, generation);
    if (started.released) return { status: "released" };
    for (const attempt of started.attempts) {
      const target = attempt.shard === null ? directory(this.env) : directoryByName(this.env, `directory-${attempt.shard}`);
      const sealed = await target.sealPlacementAttempt(attempt);
      this.placement.settle(provider, subject, attempt, sealed.userId);
    }
    return { status: this.placement.finishOrphanCleanup(provider, subject, generation) };
  }
  async bindIdentityHome(
    provider: string,
    subject: string,
    userId: string,
    authEpoch?: number,
    authExpiryMs?: number,
    requireBound = false,
    shardClaimToken?: string | null,
    checkClaim = false,
  ): Promise<void> {
    // The Worker may have sent this RPC while the OAuth state was fresh, but
    // it can be delayed in transit. Never mutate the home on an expired state.
    if (authExpiryMs !== undefined) requireFreshAuth(authExpiryMs);
    if (typeof requireBound !== "boolean" || typeof checkClaim !== "boolean" ||
        (shardClaimToken != null && (typeof shardClaimToken !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(shardClaimToken))))
      throw new AppError("invalid", "invalid account placement check");
    return this.googleWrite(provider, authEpoch, () => {
      const home = this.sql.exec<{ shard: number | null; user_id: string | null; generation: string | null; placement_state: string }>(
        `SELECT shard,user_id,generation,placement_state FROM identity_homes WHERE provider=? AND subject=?`, provider, subject,
      ).toArray()[0];
      const shard = /^s(\d+):/i.exec(userId);
      if (this.isGlobal && provider === "google" && this.inviteRevocation.hasLegacy() &&
          (!home || home.shard !== null || home.user_id !== userId))
        throw new AppError("unavailable", "invitation inventory requires review");
      // A global account can predate placement tracking. A sharded account,
      // however, must have its coordinator claim before a session is issued:
      // an absent home can also mean that the shard has an orphan identity
      // after deletion or an interrupted rollout. Do not recreate it here.
      if (!home) {
        if (directoryNameForUser(userId) !== "global")
          throw new AppError("unavailable", "sharded account placement requires review");
        // A missing legacy home does not prove this account was established
        // before revocation. An inventoried identity stays pending for review.
        if (provider === "google" && this.sql.exec(`SELECT user_id FROM invite_revocation_global_orphans
          WHERE provider=? AND subject=?`, provider, subject).toArray().length)
          throw new AppError("unavailable", "account invitation requires review");
        if (!this.sql.exec(`SELECT i.user_id FROM identities i JOIN users u ON u.user_id=i.user_id
          JOIN vaults v ON v.user_id=u.user_id WHERE i.provider=? AND i.subject=? AND i.user_id=?
            AND u.state='active' AND v.state='active'`, provider, subject, userId).toArray().length)
          throw new AppError("conflict", "account placement changed; retry sign-in");
        if (provider === "google" && this.env.INVITE_ONLY !== "false") {
          const binding = this.sql.exec<{ email: string; generation: string | null }>(
            `SELECT email,generation FROM account_invite_bindings WHERE user_id=?`, userId,
          ).toArray()[0];
          if (binding) {
            const owner = this.sql.exec<{ email: string }>(`SELECT email FROM users WHERE user_id=?`, userId).one();
            const grant = this.sql.exec<{ generation: string | null }>(`SELECT generation FROM invites WHERE email=?`, binding.email).toArray()[0];
            if (owner.email !== binding.email || !binding.generation || !grant || grant.generation !== binding.generation)
              throw new AppError("unavailable", "account invitation requires review");
          }
        }
        return;
      }
      if (home.generation && home.user_id === null)
        throw new AppError("unavailable", "registered placement must be settled before binding");
      let globalBindEmail: string | null = null;
      if (this.isGlobal && provider === "google" && home.shard === null && home.user_id === null) {
        if (this.sql.exec(`SELECT user_id FROM invite_revocation_global_orphans WHERE provider=? AND subject=?`,
          provider, subject).toArray().length)
          throw new AppError("unavailable", "account invitation requires review");
        // Accounts created by current code capture their original grant. Until
        // the home is bound, a revoked or later reissued grant cannot authorize
        // the first session. Older accounts with no binding remain compatible.
        const binding = this.sql.exec<{ email: string; generation: string | null }>(
          `SELECT email,generation FROM account_invite_bindings WHERE user_id=?`, userId,
        ).toArray()[0];
        if (binding) {
          const owner = this.sql.exec<{ email: string }>(`SELECT u.email FROM users u JOIN identities i ON i.user_id=u.user_id
            WHERE u.user_id=? AND u.state='active' AND i.provider=? AND i.subject=?`, userId, provider, subject).toArray()[0];
          if (!owner || owner.email !== binding.email)
            throw new AppError("unavailable", "account invitation requires review");
          globalBindEmail = binding.email;
          if (this.env.INVITE_ONLY !== "false") {
            const grant = this.sql.exec<{ generation: string | null }>(`SELECT generation FROM invites WHERE email=?`, binding.email).toArray()[0];
            if (!grant || !binding.generation || grant.generation !== binding.generation)
              throw new AppError("forbidden", "this invitation changed; sign-in requires review");
          }
        }
      }
      let verifiedClaim = false;
      if (home.shard !== null) {
        const stored = this.sql.exec<{ token: string }>(`SELECT token FROM shard_home_claim_tokens WHERE provider=? AND subject=?`, provider, subject).toArray()[0]?.token ?? null;
        if (checkClaim && (stored !== null || shardClaimToken != null) && (shardClaimToken ?? null) !== stored)
          throw new AppError("conflict", "account placement changed; retry sign-in");
        verifiedClaim = Boolean(stored && shardClaimToken === stored);
        // Even an older caller must not bind a newly tokenized, unbound home
        // without its token. Existing generation-less homes remain legacy.
        if (home.user_id === null && !verifiedClaim && (checkClaim || stored !== null))
          throw new AppError("unavailable", "sharded account placement requires review");
      }
      // A previously observed shard identity may be a survivor from an older
      // placement. An unbound claim cannot prove that it belongs to that user.
      if (requireBound && home.user_id === null && !verifiedClaim)
        throw new AppError("unavailable", "sharded account placement requires review");
      if (home.placement_state !== "open" || (shard ? Number(shard[1]) : null) !== home.shard ||
          (home.user_id !== null && home.user_id !== userId))
        throw new AppError("conflict", "account placement changed; retry sign-in");
      // A bound mapping needs no write and remains usable during a pending
      // legacy rescan; all consistency checks above have already run.
      if (home.user_id === userId) return;
      if (verifiedClaim && home.user_id === null)
        this.sql.exec(`INSERT INTO shard_home_bind_claim_marker(provider,subject,token) VALUES (?,?,?)`, provider, subject, shardClaimToken!);
      try {
        if (globalBindEmail !== null)
          this.sql.exec(`INSERT INTO invite_global_bind_marker(slot,provider,subject,user_id,email) VALUES (1,?,?,?,?)`,
            provider, subject, userId, globalBindEmail);
        this.sql.exec(
          `UPDATE identity_homes SET user_id=? WHERE provider=? AND subject=? AND (user_id IS NULL OR user_id=?)`,
          userId,
          provider,
          subject,
          userId,
        );
      } finally {
        if (globalBindEmail !== null) this.sql.exec(`DELETE FROM invite_global_bind_marker WHERE slot=1`);
        if (verifiedClaim && home.user_id === null)
          this.sql.exec(`DELETE FROM shard_home_bind_claim_marker WHERE provider=? AND subject=?`, provider, subject);
      }
    });
  }

  /** New callers use a distinct RPC so an older coordinator cannot ignore the claim check. */
  async bindIdentityHomeV2(provider: string, subject: string, userId: string, authEpoch: number | undefined,
    authExpiryMs: number | undefined, requireBound: boolean, shardClaimToken?: string | null): Promise<void> {
    if (!this.isGlobal || provider !== "google" || directoryNameForUser(userId) === "global")
      throw new AppError("invalid", "invalid account placement");
    return this.bindIdentityHome(provider, subject, userId, authEpoch, authExpiryMs, requireBound, shardClaimToken, true);
  }

  /** Bind only the immutable claim actually persisted by the target shard. */
  async bindIdentityHomeV3(provider: string, subject: string, userId: string, authEpoch: number | undefined,
    authExpiryMs: number | undefined, requireBound: boolean, targetClaim: ShardInviteClaim | null): Promise<void> {
    if (!this.isGlobal || provider !== "google" || directoryNameForUser(userId) === "global" || typeof requireBound !== "boolean" ||
        (targetClaim !== null && !validShardInviteClaim(targetClaim)))
      throw new AppError("invalid", "invalid account placement check");
    if (authExpiryMs !== undefined) requireFreshAuth(authExpiryMs);
    return this.googleWrite(provider, authEpoch, () => {
      const home = this.sql.exec<{ shard: number | null; user_id: string | null; generation: string | null; placement_state: string }>(
        `SELECT shard,user_id,generation,placement_state FROM identity_homes WHERE provider=? AND subject=?`, provider, subject,
      ).toArray()[0];
      const match = /^s(\d+):/i.exec(userId);
      if (!home || !match || Number(match[1]) !== home.shard || home.placement_state !== "open" || home.generation ||
          (home.user_id !== null && home.user_id !== userId))
        throw new AppError("unavailable", "account placement requires review");
      const claim = this.sql.exec<{ token: string; email: string; generation: string | null; user_id: string | null }>(
        `SELECT token,email,generation,user_id FROM shard_home_invite_claims WHERE provider=? AND subject=?`, provider, subject,
      ).toArray()[0];
      if (!claim) {
        // Never backfill a legacy home from today's invitation.
        if (targetClaim !== null || home.user_id !== userId) throw new AppError("unavailable", "legacy account placement requires review");
        return;
      }
      const storedToken = this.sql.exec<{ token: string }>(`SELECT token FROM shard_home_claim_tokens WHERE provider=? AND subject=?`, provider, subject).toArray()[0]?.token;
      if (!targetClaim || !validShardInviteClaim({ token: claim.token, email: claim.email, generation: claim.generation }) ||
          targetClaim.token !== claim.token || targetClaim.email !== claim.email || targetClaim.generation !== claim.generation ||
          storedToken !== claim.token || (claim.user_id !== null && claim.user_id !== userId) || claim.user_id !== home.user_id)
        throw new AppError("conflict", "account placement changed; retry sign-in");
      if (home.user_id === userId) return;
      // A target creation may have been delayed after the initial claim. An
      // admin can revoke the invitation in that interval, so recheck inside
      // the transaction that would first bind the account and issue access.
      // A reissue authorizes the same email while the immutable original
      // generation remains attached for later deletion.
      if (this.env.INVITE_ONLY !== "false" && !this.isInvited(claim.email))
        throw new AppError("forbidden", "this email has not been invited to the beta yet");
      this.sql.exec(`INSERT INTO shard_home_bind_claim_marker(provider,subject,token) VALUES (?,?,?)`, provider, subject, claim.token);
      this.sql.exec(`INSERT INTO shard_invite_bind_marker(provider,subject,token) VALUES (?,?,?)`, provider, subject, claim.token);
      try {
        this.sql.exec(`UPDATE identity_homes SET user_id=? WHERE provider=? AND subject=? AND user_id IS NULL`, userId, provider, subject);
        this.sql.exec(`UPDATE shard_home_invite_claims SET user_id=? WHERE provider=? AND subject=? AND user_id IS NULL`, userId, provider, subject);
      } finally {
        this.sql.exec(`DELETE FROM shard_invite_bind_marker WHERE provider=? AND subject=?`, provider, subject);
        this.sql.exec(`DELETE FROM shard_home_bind_claim_marker WHERE provider=? AND subject=?`, provider, subject);
      }
    });
  }
  async deletionProbe(userId: string, vaultId: string): Promise<number> {
    let count = 0;
    for (const table of [
      "users",
      "identities",
      "vaults",
      "billing_accounts",
      "billing_delivery_retries",
      "vault_replacements",
      "retired_vaults",
      "account_final_sweeps",
      "invite_deletion_receipts",
      "account_invite_deletions",
      "account_invite_bindings",
      "shard_home_invite_claims",
      "shard_invite_account_bindings",
      "shard_invite_target_seals",
      "shard_revoked_invite_claims",
      "invite_revocation_claims",
      "invite_revocation_global_orphans",
      "invite_inventory_barrier",
      "identity_homes",
      "placement_finalizations",
      "placement_receipts",
      "placement_identities",
      "shard_identity_claim_tokens",
      "shard_deletion_releases",
      "shard_identity_delete_marker",
      "global_shard_home_release_marker",
      "shard_google_delete_v3_marker",
      "global_google_release_v3_marker",
    ]) {
      count += this.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM ${table} WHERE user_id=?`,
          userId,
        )
        .one().n;
    }
    count += this.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM shard_home_claim_tokens t JOIN identity_homes h ON h.provider=t.provider AND h.subject=t.subject WHERE h.user_id=?`,
      userId,
    ).one().n;
    // Orphaned and unbound coordinator tokens have no attributable user ID.
    // Never report a zero for any deletion while such an identity marker exists.
    count += this.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM shard_home_claim_tokens t LEFT JOIN identity_homes h ON h.provider=t.provider AND h.subject=t.subject WHERE h.provider IS NULL OR h.user_id IS NULL`,
    ).one().n;
    // A nonempty transaction marker is not expected outside a successful bind.
    count += this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM shard_home_bind_claim_marker`).one().n;
    count += this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM shard_invite_bind_marker`).one().n;
    count += this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM shard_invite_target_close_marker`).one().n;
    count += this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM shard_invite_create_marker`).one().n;
    for (const table of ["invite_revocation_barrier", "invite_revocation_quarantines", "invite_quarantine_marker", "invite_global_bind_marker", "invite_revocation_legacy_operations", "invite_revocation_legacy_marker", "invite_revocation_mutation_marker", "invite_registration_marker", "invite_delete_authorizations_v4"]) {
      count += this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;
    }
    count += this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM invite_revocation_claims
      WHERE (state='created' AND (user_id IS NULL OR vault_id IS NULL)) OR (vault_id=? AND (user_id IS NULL OR user_id<>?))`, vaultId, userId).one().n;
    count += this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM invite_revocation_global_orphans
      WHERE vault_id=? AND user_id<>?`, vaultId, userId).one().n;
    count += this.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM shard_invite_target_seals WHERE vault_id=? AND user_id<>?`, vaultId, userId,
    ).one().n;
    count += this.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM shard_revoked_invite_claims WHERE vault_id=? AND (user_id IS NULL OR user_id<>?)`, vaultId, userId,
    ).one().n;
    count += this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM shard_revoked_invite_claims
      WHERE (state='created' AND (user_id IS NULL OR user_id='' OR vault_id IS NULL OR vault_id=''))
         OR (state IN ('absent','closed') AND (user_id IS NOT NULL OR vault_id IS NOT NULL))`).one().n;
    count += this.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM shard_home_invite_claims c LEFT JOIN identity_homes h ON h.provider=c.provider AND h.subject=c.subject
       WHERE c.user_id IS NULL OR h.provider IS NULL OR h.user_id IS NULL OR h.user_id<>c.user_id`,
    ).one().n;
    count += this.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM billing_events WHERE user_id=?`,
        userId,
      )
      .one().n;
    // An older webhook could have persisted a customer-only event. We cannot
    // attribute it after the customer's link has been erased, so conservatively
    // hold every deletion probe pending while any such event remains. This does
    // not prove that events attributed to the wrong user are absent.
    count += this.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM billing_events WHERE user_id IS NULL OR user_id=''`,
    ).one().n;
    // Initialization fences are keyed by vault rather than owner and can
    // outlive the Directory row that originally linked the two.
    count += this.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM vault_initializations WHERE vault_id=?`,
        vaultId,
      )
      .one().n;
    count += this.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM vaults WHERE vault_id=? AND user_id<>?`,
        vaultId,
        userId,
      )
      .one().n;
    count += this.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM account_final_sweeps WHERE vault_id=? AND user_id<>?`, vaultId, userId,
    ).one().n;
    count += this.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM invite_deletion_receipts WHERE vault_id=? AND user_id<>?`, vaultId, userId,
    ).one().n;
    count += this.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM account_invite_deletions WHERE vault_id=? AND user_id<>?`, vaultId, userId,
    ).one().n;
    count += this.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM invite_inventory_barrier WHERE vault_id=? AND user_id<>?`, vaultId, userId,
    ).one().n;
    count += this.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM shard_invite_inventory WHERE excluded_user_id=?`, userId,
    ).one().n;
    // An unattributed open receipt, or a supposedly closed receipt that still
    // carries identity, prevents any account audit from claiming zero.
    count += this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM invite_deletion_receipts
      WHERE (state IN ('captured','removed') AND (user_id IS NULL OR user_id='' OR vault_id IS NULL OR vault_id='' OR email IS NULL OR email=''))
         OR (state='closed' AND (user_id IS NOT NULL OR vault_id IS NOT NULL OR email IS NOT NULL OR generation IS NOT NULL))`).one().n;
    count += this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM invite_delete_permits`).one().n;
    count += this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM invite_delete_authorizations`).one().n;
    count += this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM invite_delete_authorizations_v2`).one().n;
    count += this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM invite_delete_authorizations_v3`).one().n;
    return count;
  }

  /**
   * A bounded, read-only observation for an Access-protected diagnostic.
   * It is not a deletion fence: other requests and older code may create an
   * account before or after this object's snapshot.
   */
  async inviteUserInventory(email: string): Promise<
    | { status: "observed"; active: number; deleting: number }
    | { status: "invalid_rows" | "row_limit" }
  > {
    if (typeof email !== "string" || !email.trim() || email.length > 320)
      throw new AppError("invalid", "invalid inventory request");
    const normalized = email.trim().toLowerCase();
    let scanned = 0, active = 0, deleting = 0;
    for (const row of this.sql.exec<{ user_id: SqlStorageValue; email: SqlStorageValue; state: SqlStorageValue }>(
      `SELECT user_id,email,state FROM users ORDER BY rowid LIMIT 10001`,
    )) {
      if (++scanned > 10_000) return { status: "row_limit" };
      if (typeof row.user_id !== "string" || !row.user_id ||
          typeof row.email !== "string" || !row.email.trim() || row.email.length > 320 ||
          (row.state !== "active" && row.state !== "deleting"))
        return { status: "invalid_rows" };
      // SQLite lower() does not implement the JavaScript normalization used
      // at sign-in, including for legacy Unicode rows.
      if (row.email.trim().toLowerCase() === normalized) {
        if (row.state === "active") active++;
        else deleting++;
      }
    }
    return { status: "observed", active, deleting };
  }

  async forgetIdentityHome(
    provider: string,
    subject: string,
    shard: number | null,
    userId: string,
  ): Promise<void> {
    // An older delayed RPC must not erase a newer account's claim, even when
    // it was placed on the same shard. Do not clear an unbound claim: it may
    // already belong to an in-flight replacement sign-in.
    if (typeof userId !== "string" || !userId)
      throw new AppError("unavailable", "account placement requires review");
    // An absent or different home used to return success, which an older
    // shard could mistake for a fenced Google deletion. The V3 release is
    // the only Google shard release allowed after the coordinator migrates.
    if (this.isGlobal && provider === "google" && shard !== null &&
        this.sql.exec(`SELECT key FROM meta WHERE key='global_shard_release_v3_guard' AND value='1'`).toArray().length)
      throw new AppError("unavailable", "account placement requires review");
    const home = this.sql.exec<{ shard: number | null; user_id: string | null; generation: string | null }>(
      `SELECT shard,user_id,generation FROM identity_homes WHERE provider=? AND subject=?`, provider, subject,
    ).toArray()[0];
    if (!home) return;
    if (home.generation) throw new AppError("unavailable", "fenced account placement requires finalization");
    if (home.user_id === null)
      throw new AppError("unavailable", "account placement requires review");
    if (home.shard !== shard) {
      // A claim for a different user is not ours to remove. If it still
      // references this user, don't falsely report erasure as complete.
      if (home.user_id === userId)
        throw new AppError("unavailable", "account placement requires review");
      return;
    }
    this.sql.exec(
      `DELETE FROM identity_homes WHERE provider=? AND subject=? AND shard IS ? AND user_id=?`,
      provider,
      subject,
      shard,
      userId,
    );
  }

  /**
   * Release a shard's Google home and invalidate authorizations issued before
   * that release in one global transaction. The caller durably acknowledges a
   * successful reply; an ambiguous reply may safely cause another bump.
   * This does not fence a creation RPC already dispatched to a shard.
   */
  async forgetGoogleShardHomeV2(subject: string, shard: number, userId: string): Promise<void> {
    const home = /^s(\d{1,2}):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(userId);
    if (!this.isGlobal || !Number.isInteger(shard) || shard < 0 || shard > 15 ||
        !home || Number(home[1]) !== shard)
      throw new AppError("invalid", "invalid account placement");
    this.ctx.storage.transactionSync(() => {
      // A no-home V2 call does not execute DELETE, so the SQL DELETE trigger
      // cannot reject it. Never acknowledge this legacy release once V3 is
      // active, even after another attempt has already removed the home.
      if (this.sql.exec(`SELECT key FROM meta WHERE key='global_shard_release_v3_guard' AND value='1'`).toArray().length)
        throw new AppError("unavailable", "account placement requires review");
      const home = this.sql.exec<{ shard: number | null; user_id: string | null; generation: string | null }>(
        `SELECT shard,user_id,generation FROM identity_homes WHERE provider='google' AND subject=?`, subject,
      ).toArray()[0];
      if (home?.generation)
        throw new AppError("unavailable", "fenced account placement requires finalization");
      if (home && home.user_id === null)
        throw new AppError("unavailable", "account placement requires review");
      if (home && home.shard !== shard && home.user_id === userId)
        throw new AppError("unavailable", "account placement requires review");
      const epoch = this.readGoogleAuthEpoch();
      if (epoch >= Number.MAX_SAFE_INTEGER)
        throw new AppError("unavailable", "sign-in coordinator requires review");
      this.sql.exec(`UPDATE meta SET value=? WHERE key='global_auth_epoch'`, String(epoch + 1));
      // A delayed release must never erase a different account's home.
      if (!home || home.shard !== shard || home.user_id !== userId) return;
      this.sql.exec(`INSERT INTO global_shard_home_release_marker(provider,subject,user_id) VALUES ('google',?,?)`, subject, userId);
      try {
        this.sql.exec(`DELETE FROM identity_homes WHERE provider='google' AND subject=? AND shard=? AND user_id=?`, subject, shard, userId);
      } finally {
        this.sql.exec(`DELETE FROM global_shard_home_release_marker WHERE provider='google' AND subject=? AND user_id=?`, subject, userId);
      }
    });
  }

  /** Release and return a new epoch that the shard must install before erasing its identity. */
  async forgetGoogleShardHomeV3(subject: string, shard: number, userId: string): Promise<number> {
    const owner = /^s(\d{1,2}):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.exec(userId);
    if (!this.isGlobal || !Number.isInteger(shard) || shard < 0 || shard > 15 || !owner || Number(owner[1]) !== shard)
      throw new AppError("invalid", "invalid account placement");
    return this.ctx.storage.transactionSync(() => {
      const home = this.sql.exec<{ shard: number | null; user_id: string | null; generation: string | null }>(
        `SELECT shard,user_id,generation FROM identity_homes WHERE provider='google' AND subject=?`, subject,
      ).toArray()[0];
      // A different or unbound home can represent an unresolved concurrent
      // placement. Never certify this deletion while its ownership conflicts.
      if (this.sql.exec(`SELECT user_id FROM identities WHERE provider='google' AND subject=?`, subject).toArray().length ||
          home?.generation || (home && (home.user_id !== userId || home.shard !== shard)))
        throw new AppError("unavailable", "account placement requires review");
      const epoch = this.readGoogleAuthEpoch();
      if (epoch >= Number.MAX_SAFE_INTEGER)
        throw new AppError("unavailable", "sign-in coordinator requires review");
      const next = epoch + 1;
      this.sql.exec(`UPDATE meta SET value=? WHERE key='global_auth_epoch'`, String(next));
      if (home && home.shard === shard && home.user_id === userId) {
        this.sql.exec(`INSERT INTO global_shard_home_release_marker(provider,subject,user_id) VALUES ('google',?,?)`, subject, userId);
        this.sql.exec(`INSERT INTO global_google_release_v3_marker(provider,subject,user_id) VALUES ('google',?,?)`, subject, userId);
        try {
          this.sql.exec(`DELETE FROM identity_homes WHERE provider='google' AND subject=? AND shard=? AND user_id=?`, subject, shard, userId);
        } finally {
          this.sql.exec(`DELETE FROM global_google_release_v3_marker WHERE provider='google' AND subject=? AND user_id=?`, subject, userId);
          this.sql.exec(`DELETE FROM global_shard_home_release_marker WHERE provider='google' AND subject=? AND user_id=?`, subject, userId);
        }
      }
      return next;
    });
  }
  async hasVault(vaultId: string): Promise<boolean> {
    return !!this.sql
      .exec(
        `SELECT vault_id FROM vaults WHERE vault_id=? UNION SELECT target_id AS vault_id FROM vault_replacements WHERE target_id=? OR source_id=? UNION SELECT vault_id FROM retired_vaults WHERE vault_id=?`,
        vaultId,
        vaultId,
        vaultId,
        vaultId,
      )
      .toArray()[0];
  }

  /** Read-only mapping for deletion diagnostics. The token is never a deletion authority. */
  async deletionFenceMapping(vaultId: string, userId: string): Promise<
    | { status: "absent" }
    | { status: "unavailable" }
    | { status: "matched"; token: string; initializationPending: boolean }
  > {
    const primary = this.sql.exec<{ user_id: string; state: string; user_state: string | null; operation_id: string | null }>(
      `SELECT v.user_id,v.state,u.state AS user_state,i.operation_id
       FROM vaults v LEFT JOIN users u ON u.user_id=v.user_id
       LEFT JOIN account_invite_deletions i ON i.user_id=v.user_id AND i.vault_id=v.vault_id
       WHERE v.vault_id=?`, vaultId,
    ).toArray();
    const retired = this.sql.exec<{ user_id: string; state: string; generation: string | null }>(
      `SELECT user_id,state,generation FROM retired_vaults WHERE vault_id=?`, vaultId,
    ).toArray();
    if (primary.length + retired.length === 0) return { status: "absent" };
    if (primary.length + retired.length !== 1) return { status: "unavailable" };
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    let token: string;
    if (primary.length === 1) {
      const row = primary[0]!;
      if (row.user_id !== userId || row.user_state !== "deleting" ||
          !["deleting", "swept"].includes(row.state) || !row.operation_id || !uuid.test(row.operation_id))
        return { status: "unavailable" };
      token = `account:${row.operation_id}:${row.state}`;
    } else {
      const row = retired[0]!;
      if (row.user_id !== userId || !["deleting", "awaiting_final_sweep"].includes(row.state) ||
          !row.generation || !uuid.test(row.generation)) return { status: "unavailable" };
      token = `retired:${row.generation}:${row.state}`;
    }
    const initializationPending = this.sql.exec(
      `SELECT vault_id FROM vault_initializations WHERE vault_id=? LIMIT 1`, vaultId,
    ).toArray().length > 0;
    return { status: "matched", token, initializationPending };
  }
  async prepareReplacement(
    sourceId: string,
    operationId: string,
  ): Promise<{ targetVaultId: string }> {
    const prior = this.sql
      .exec<{ source_id: string; target_id: string; user_id: string; state: string }>(
        `SELECT * FROM vault_replacements WHERE operation_id=?`,
        operationId,
      )
      .toArray()[0];
    if (prior) {
      if (prior.source_id !== sourceId)
        throw new AppError("conflict", "operation belongs to another vault");
      this.requireActiveReplacement(prior.user_id, prior.source_id, prior.target_id, prior.state);
      if (prior.state === "preparing") {
        await this.initializeVault(prior.target_id, prior.user_id);
        this.checkReplacementAfterInit(operationId, prior.user_id, sourceId, prior.target_id);
      }
      return { targetVaultId: prior.target_id };
    }
    const source = this.sql
      .exec<{ user_id: string }>(
        `SELECT v.user_id FROM vaults v JOIN users u ON v.user_id=u.user_id WHERE v.vault_id=? AND v.state='active' AND u.state='active'`,
        sourceId,
      )
      .toArray()[0];
    if (!source) throw new AppError("not_found", "no active source vault");
    if (
      this.sql
        .exec(
          `SELECT operation_id FROM vault_replacements WHERE source_id=? AND state='preparing'`,
          sourceId,
        )
        .toArray().length
    )
      throw new AppError("conflict", "a replacement is already being prepared");
    const targetId = this.env.VAULT.newUniqueId().toString();
    this.sql.exec(
      `INSERT INTO vault_replacements (operation_id,source_id,target_id,user_id) VALUES (?,?,?,?)`,
      operationId,
      sourceId,
      targetId,
      source.user_id,
    );
    await this.initializeVault(targetId, source.user_id);
    this.checkReplacementAfterInit(operationId, source.user_id, sourceId, targetId);
    return { targetVaultId: targetId };
  }

  private requireActiveReplacement(userId: string, sourceId: string, targetId: string, state: string): void {
    const expected = state === "preparing" ? sourceId : state === "complete" ? targetId : "";
    const active = this.sql.exec(
      `SELECT v.vault_id FROM vaults v JOIN users u ON v.user_id=u.user_id WHERE v.vault_id=? AND v.user_id=? AND v.state='active' AND u.state='active'`,
      expected, userId,
    ).toArray().length > 0;
    if (!active) throw new AppError("conflict", "replacement account is no longer active");
  }

  private checkReplacementAfterInit(operationId: string, userId: string, sourceId: string, targetId: string): void {
    const operation = this.sql.exec<{ source_id: string; target_id: string; user_id: string; state: string }>(
      `SELECT source_id,target_id,user_id,state FROM vault_replacements WHERE operation_id=?`, operationId,
    ).toArray()[0];
    if (!operation || operation.source_id !== sourceId || operation.target_id !== targetId || operation.user_id !== userId)
      throw new AppError("conflict", "replacement changed during initialization");
    this.requireActiveReplacement(userId, sourceId, targetId, operation.state);
  }
  async cutover(
    sourceId: string,
    targetId: string,
    operationId: string,
  ): Promise<void> {
    requireMaintenanceFence(sourceId, this.env.RESTORE_FENCE_IDS);
    requireMaintenanceFence(targetId, this.env.RESTORE_FENCE_IDS);
    const operation = this.sql
      .exec<{
        source_id: string;
        target_id: string;
        user_id: string;
        state: string;
      }>(`SELECT * FROM vault_replacements WHERE operation_id=?`, operationId)
      .toArray()[0];
    if (
      !operation ||
      operation.source_id !== sourceId ||
      operation.target_id !== targetId
    )
      throw new AppError("conflict", "replacement does not match");
    if (operation.state === "complete") return;
    if (operation.state !== "preparing")
      throw new AppError("conflict", "replacement is no longer preparing");
    this.requireInitializationSettled(targetId);
    await revokeOAuthUserGrants(this.env, operation.user_id);
    this.requireInitializationSettled(targetId);
    await this.env.VAULT.get(
      this.env.VAULT.idFromString(targetId),
    ).activateImport(operationId, operation.user_id);
    await this.ctx.storage.transaction(async () => {
      this.requireInitializationSettled(targetId);
      // Activation yields. Deletion may have retired the target while that
      // call was in flight; never publish a cancelled or retired target.
      if (!this.sql.exec(
        `SELECT operation_id FROM vault_replacements WHERE operation_id=? AND source_id=? AND target_id=? AND user_id=? AND state='preparing'`,
        operationId, sourceId, targetId, operation.user_id,
      ).toArray().length || this.sql.exec(`SELECT vault_id FROM retired_vaults WHERE vault_id=?`, targetId).toArray().length)
        throw new AppError("conflict", "replacement is no longer preparing");
      const source = this.sql
        .exec(
          `SELECT v.vault_id FROM vaults v JOIN users u ON u.user_id=v.user_id WHERE v.vault_id=? AND v.user_id=? AND v.state='active' AND u.state='active'`,
          sourceId, operation.user_id,
        )
        .toArray()[0];
      if (!source)
        throw new AppError("conflict", "source vault is no longer active");
      this.sql.exec(
        `UPDATE vaults SET vault_id=?,updated_at=? WHERE vault_id=?`,
        targetId,
        Date.now(),
        sourceId,
      );
      this.sql.exec(
        `INSERT OR IGNORE INTO retired_vaults (vault_id,user_id) VALUES (?,?)`,
        sourceId,
        operation.user_id,
      );
      this.sql.exec(
        `UPDATE vault_replacements SET state='complete' WHERE operation_id=?`,
        operationId,
      );
      // A delivered plan may have reached only the source or been delivered
      // after the import snapshot. Force the current revision to the target.
      this.billing.redeliverAfterReplacement(operation.user_id);
      // The retry and retired-vault cleanup must survive a crash immediately
      // after publishing the new home.
      const now = Date.now();
      const alarm = await this.ctx.storage.getAlarm();
      if (alarm === null || alarm > now) await this.ctx.storage.setAlarm(now);
    });
  }

  /** Marks the account for deletion; alarm() does the work and retries until it is done. */
  async deleteAccount(userId: string, expectedVaultId: string): Promise<void> {
    if (typeof expectedVaultId !== "string" || !expectedVaultId)
      throw new AppError("conflict", "the account vault has changed");
    const now = Date.now();
    // Keep the deletion state and its first alarm in the same SQLite-backed
    // storage transaction. If scheduling fails, the account remains active
    // and the caller can retry with the same session.
    const toQuiesce = await this.ctx.storage.transaction(async () => {
      const expected = this.sql.exec(
        `SELECT vault_id FROM vaults WHERE user_id = ? AND vault_id = ? AND state IN ('creating', 'active', 'deleting')`,
        userId, expectedVaultId,
      ).toArray();
      if (expected.length !== 1)
        throw new AppError("conflict", "the account vault has changed");
      const owner = this.sql.exec<{ email: string; state: string }>(`SELECT email,state FROM users WHERE user_id=?`, userId).toArray()[0];
      if (!owner || !["active", "deleting"].includes(owner.state))
        throw new AppError("unavailable", "account deletion requires review");
      let invite = this.sql.exec<{ vault_id: string; operation_id: string }>(
        `SELECT vault_id,operation_id FROM account_invite_deletions WHERE user_id=?`, userId,
      ).toArray()[0];
      if (!invite) {
        // A deletion already in progress before this migration has no safe
        // capture time: do not adopt a possibly reissued invitation.
        if (owner.state !== "active") throw new AppError("unavailable", "account invitation requires review");
        invite = { vault_id: expectedVaultId, operation_id: crypto.randomUUID() };
        this.sql.exec(`INSERT INTO account_invite_deletions(user_id,vault_id,operation_id) VALUES (?,?,?)`, userId, expectedVaultId, invite.operation_id);
      } else if (invite.vault_id !== expectedVaultId || owner.state !== "deleting") {
        throw new AppError("unavailable", "account invitation requires review");
      }
      // For a global-home account, capture and mark deletion atomically in
      // this one object. A sharded home captures immediately after commit.
      if (this.isGlobal) {
        const normalized = this.inviteDeletionIdentity(invite.operation_id, userId, expectedVaultId, owner.email);
        this.captureInviteRow(invite.operation_id, userId, expectedVaultId, normalized);
      }
      const active = this.sql.exec<{ vault_id: string }>(
        `SELECT vault_id FROM vaults WHERE user_id = ? AND state IN ('active', 'deleting')`,
        userId,
      ).toArray();
      const targets = this.sql.exec<{ vault_id: string }>(
        `SELECT target_id AS vault_id FROM vault_replacements WHERE user_id=? AND
         (state='preparing' OR (state='cancelled' AND EXISTS (SELECT 1 FROM retired_vaults WHERE vault_id=target_id)))`,
        userId,
      ).toArray();
      this.sql.exec(
        `UPDATE users SET state = 'deleting' WHERE user_id = ?`,
        userId,
      );
      this.sql.exec(
        `INSERT OR IGNORE INTO retired_vaults (vault_id,user_id) SELECT target_id,user_id FROM vault_replacements WHERE user_id=? AND state='preparing'`,
        userId,
      );
      this.sql.exec(`UPDATE vault_replacements SET state='cancelled' WHERE user_id=? AND state='preparing'`, userId);
      this.sql.exec(
        `UPDATE vaults SET state = 'deleting', updated_at = ? WHERE user_id = ? AND state IN ('creating', 'active')`,
        now,
        userId,
      );
      const existing = await this.ctx.storage.getAlarm();
      if (existing === null || existing > now + RETRY_MS)
        await this.ctx.storage.setAlarm(now + RETRY_MS);
      return { active: [...new Set(active.map((v) => v.vault_id))], targets: [...new Set(targets.map((v) => v.vault_id))], inviteOperation: invite.operation_id, email: owner.email };
    });
    // A preparing replacement may still be copying files. Revoke its Vault
    // as well as the active one immediately, rather than waiting for the
    // retirement alarm. The alarm remains responsible for retry and cleanup.
    // Attempt every Vault even if another one is unavailable.
    const results = await Promise.allSettled([
      ...(this.isGlobal ? [] : [directory(this.env).captureInviteForDeletion(toQuiesce.inviteOperation, userId, expectedVaultId, toQuiesce.email)]),
      ...toQuiesce.active.map(async (id) => this.env.VAULT.get(this.env.VAULT.idFromString(id)).quiesceForAccountDeletion(userId)),
      ...toQuiesce.targets.map(async (id) => this.env.VAULT.get(this.env.VAULT.idFromString(id)).quiesceForRetirement(userId)),
    ]);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  }

  async listVaults(p: { after?: string; limit: number }): Promise<VaultRow[]> {
    const limit = Math.max(1, Math.min(200, Math.floor(p.limit)));
    return this.sql
      .exec<VaultDbRow>(
        `SELECT v.vault_id, v.user_id, u.email, v.hint, v.state, v.swept_at, v.updated_at, v.stripe_customer, v.stripe_checkout_sessions
         FROM vaults v JOIN users u ON u.user_id = v.user_id
         WHERE v.vault_id > ? ORDER BY v.vault_id LIMIT ?`,
        p.after ?? "",
        limit,
      )
      .toArray()
      .map((r) => ({
        vaultId: r.vault_id,
        userId: r.user_id,
        email: r.email,
        hint: r.hint,
        state: r.state as VaultRow["state"],
        updatedAt: r.updated_at,
      }));
  }

  async addInvite(email: string): Promise<void> {
    this.sql.exec(
      `INSERT OR IGNORE INTO invites (email, created_at) VALUES (?, ?)`,
      email.trim().toLowerCase(),
      Date.now(),
    );
  }

  /** Legacy callers cannot prove whether this is an admin request or a stale finalizer. */
  async removeInvite(_email: string): Promise<void> {
    throw new AppError("unavailable", "invitation service is updating; try again");
  }

  /** A distinct RPC makes older unconditional finalizers fail closed. */
  async removeInviteV2(_email: string): Promise<void> {
    throw new AppError("unavailable", "invitation service is updating; try again");
  }

  /** Execute only inside the transaction that authorized this particular deletion. */
  private deleteInvite(email: string, generation?: string): void {
    this.sql.exec(`INSERT INTO invite_delete_authorizations_v4(email) VALUES (?)`, email);
    try {
      this.sql.exec(`INSERT INTO invite_delete_authorizations_v3(email) VALUES (?)`, email);
      try {
        this.sql.exec(`INSERT INTO invite_delete_authorizations_v2(email) VALUES (?)`, email);
        try {
          this.sql.exec(`INSERT INTO invite_delete_authorizations(email) VALUES (?)`, email);
          try {
            this.sql.exec(`INSERT INTO invite_delete_permits(email) VALUES (?)`, email);
            try {
              if (generation === undefined) this.sql.exec(`DELETE FROM invites WHERE email=?`, email);
              else this.sql.exec(`DELETE FROM invites WHERE email=? AND generation=?`, email, generation);
            } finally {
              this.sql.exec(`DELETE FROM invite_delete_permits WHERE email=?`, email);
            }
          } finally {
            this.sql.exec(`DELETE FROM invite_delete_authorizations WHERE email=?`, email);
          }
        } finally {
          this.sql.exec(`DELETE FROM invite_delete_authorizations_v2 WHERE email=?`, email);
        }
      } finally {
        this.sql.exec(`DELETE FROM invite_delete_authorizations_v3 WHERE email=?`, email);
      }
    } finally {
      this.sql.exec(`DELETE FROM invite_delete_authorizations_v4 WHERE email=?`, email);
    }
  }

  private inviteDeletionIdentity(operationId: string, userId: string, vaultId: string, email: string): string {
    if (!this.isGlobal || typeof operationId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationId) ||
        typeof userId !== "string" || !userId || userId.length > 100 ||
        typeof vaultId !== "string" || !/^[a-f0-9]{64}$/i.test(vaultId) ||
        typeof email !== "string" || !email.trim() || email.length > 320)
      throw new AppError("invalid", "invalid invite deletion");
    return email.trim().toLowerCase();
  }

  private requireRedactedInviteReceipt(row: { user_id: string | null; vault_id: string | null; email: string | null; generation: string | null }): void {
    if (row.user_id !== null || row.vault_id !== null || row.email !== null || row.generation !== null)
      throw new AppError("unavailable", "invite deletion receipt requires review");
  }

  /** Capture once; a retry must never adopt an invite issued after the first capture. */
  async captureInviteForDeletion(operationId: string, userId: string, vaultId: string, email: string): Promise<void> {
    const normalized = this.inviteDeletionIdentity(operationId, userId, vaultId, email);
    this.ctx.storage.transactionSync(() => this.captureInviteRow(operationId, userId, vaultId, normalized));
  }

  /** Caller must already hold the transaction containing its ownership check. */
  private captureInviteRow(operationId: string, userId: string, vaultId: string, normalized: string): void {
    const existing = this.sql.exec<{ user_id: string | null; vault_id: string | null; email: string | null; generation: string | null; state: string }>(
      `SELECT user_id,vault_id,email,generation,state FROM invite_deletion_receipts WHERE operation_id=?`, operationId,
    ).toArray()[0];
    if (existing) {
      if (existing.state === "closed") { this.requireRedactedInviteReceipt(existing); return; }
      if (existing.user_id !== userId || existing.vault_id !== vaultId || existing.email !== normalized || !["captured", "removed"].includes(existing.state))
        throw new AppError("conflict", "invite deletion changed; retry cleanup");
      return;
    }
    const invite = this.sql.exec<{ generation: string | null }>(`SELECT generation FROM invites WHERE email=?`, normalized).toArray()[0];
    if (invite && (typeof invite.generation !== "string" || !/^[a-f0-9]{32}$/.test(invite.generation)))
      throw new AppError("unavailable", "invite requires operator review");
    const binding = directoryNameForUser(userId) === "global"
      ? this.sql.exec<{ email: string; generation: string | null }>(
          `SELECT email,generation FROM account_invite_bindings WHERE user_id=?`, userId,
        ).toArray()[0]
      : boundShardInviteClaim(this.sql, userId, normalized);
    if (binding && (binding.email !== normalized ||
        (binding.generation !== null && (typeof binding.generation !== "string" || !/^[a-f0-9]{32}$/.test(binding.generation)))))
      throw new AppError("unavailable", "invitation binding requires review");
    // An absent binding is legacy/ambiguous, not proof that there was no
    // invitation. Capture the observed generation so a later reissue permits
    // cleanup, but never delete that captured generation without a binding.
    this.sql.exec(`INSERT INTO invite_deletion_receipts(operation_id,user_id,vault_id,email,generation,state,binding_verified) VALUES (?,?,?,?,?,'captured',?)`,
      operationId, userId, vaultId, normalized, binding ? binding.generation : invite?.generation ?? null, binding ? 1 : 0);
  }

  /** Remove only the captured incarnation; a later invitation must survive. */
  async removeCapturedInvite(operationId: string, userId: string, vaultId: string, email: string, finalGeneration?: string): Promise<void> {
    const normalized = this.inviteDeletionIdentity(operationId, userId, vaultId, email);
    const needsInventory = this.ctx.storage.transactionSync((): InventoryIdentity | null => {
      const row = this.sql.exec<{ user_id: string | null; vault_id: string | null; email: string | null; generation: string | null; state: string; binding_verified: number }>(
        `SELECT user_id,vault_id,email,generation,state,binding_verified FROM invite_deletion_receipts WHERE operation_id=?`, operationId,
      ).toArray()[0];
      if (!row) throw new AppError("unavailable", "invite deletion requires capture");
      if (row.state === "closed") { this.requireRedactedInviteReceipt(row); return null; }
      if (row.user_id !== userId || row.vault_id !== vaultId || row.email !== normalized || !["captured", "removed"].includes(row.state))
        throw new AppError("conflict", "invite deletion changed; retry cleanup");
      if (row.state === "removed") return null;
      if (directoryNameForUser(userId) !== "global") {
        // A legacy shard account has no creation-time binding. Never infer it
        // from the currently visible invitation, which may be a reissue.
        const current = row.generation && this.sql.exec(`SELECT email FROM invites WHERE email=? AND generation=?`, normalized, row.generation).toArray().length;
        if (current) {
          const binding = boundShardInviteClaim(this.sql, userId, normalized);
          if (row.binding_verified !== 1 || !binding || binding.generation !== row.generation)
            throw new AppError("unavailable", "sharded invite requires operator review");
          if (typeof finalGeneration !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(finalGeneration))
            throw new AppError("unavailable", "account deletion requires finalization identity");
          if (!this.hasOtherLocalInviteUser(userId, normalized))
            return { operationId, userId, vaultId, email: normalized, finalGeneration };
        }
        // No grant is deleted here. The sending shard still rechecks the
        // original finalization after the RPC before completing deletion.
        this.sql.exec(`UPDATE invite_deletion_receipts SET state='removed' WHERE operation_id=? AND state='captured'`, operationId);
        return null;
      }
      if (typeof finalGeneration !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(finalGeneration))
        throw new AppError("unavailable", "account deletion requires finalization identity");
      const b = { operationId, userId, vaultId, email: normalized, finalGeneration };
      // A delayed RPC must not advance an earlier finalization's receipt, even
      // when no invitation needs removing.
      this.requireInventoryOwner(b);
      if (row.generation !== null && !/^[a-f0-9]{32}$/.test(row.generation))
        throw new AppError("unavailable", "invite requires operator review");
      const current = row.generation && this.sql.exec(`SELECT email FROM invites WHERE email=? AND generation=?`, normalized, row.generation).toArray().length;
      if (current) {
        const binding = this.sql.exec<{ email: string; generation: string | null }>(`SELECT email,generation FROM account_invite_bindings WHERE user_id=?`, userId).toArray()[0];
        if (row.binding_verified !== 1 || !binding || binding.email !== normalized || binding.generation !== row.generation)
          throw new AppError("unavailable", "invitation generation requires operator review");
        if (!this.hasOtherLocalInviteUser(userId, normalized)) return b;
      }
      this.sql.exec(`UPDATE invite_deletion_receipts SET state='removed' WHERE operation_id=? AND state='captured'`, operationId);
      return null;
    });
    if (!needsInventory) return;
    if (!this.inviteInventoryEnabled()) throw new AppError("unavailable", "invitation inventory rollout requires verification");
    await this.inviteCoordinator.begin(needsInventory);
    await this.inviteCoordinator.resume();
    const row = this.sql.exec<{ state: string }>(`SELECT state FROM invite_deletion_receipts WHERE operation_id=?`, operationId).toArray()[0];
    if (!row || (row.state !== "removed" && row.state !== "closed"))
      throw new AppError("unavailable", "invitation inventory is pending");
  }

  /** Caller holds the same transaction as the captured-generation removal. */
  private hasOtherLocalInviteUser(userId: string, email: string): boolean {
    let scanned = 0;
    let otherActive = false;
    // This control-plane scan is deliberately bounded. A larger directory
    // needs a separately verified index or operator reconciliation.
    for (const row of this.sql.exec<{ user_id: SqlStorageValue; email: SqlStorageValue; state: SqlStorageValue }>(`SELECT user_id,email,state FROM users ORDER BY rowid LIMIT 10001`)) {
      if (++scanned > 10_000) throw new AppError("unavailable", "invitation ownership inventory requires review");
      if (typeof row.user_id !== "string" || !row.user_id || typeof row.email !== "string" || !row.email.trim() || row.email.length > 320 ||
          (row.state !== "active" && row.state !== "deleting"))
        throw new AppError("unavailable", "invitation ownership requires review");
      if (row.user_id !== userId && row.email.trim().toLowerCase() === email) {
        if (row.state === "active") otherActive = true;
      }
    }
    return otherActive;
  }

  /** Preserve a non-identifying tombstone against late capture or removal RPCs. */
  async closeInviteDeletion(operationId: string, userId: string, vaultId: string, email: string): Promise<void> {
    const normalized = this.inviteDeletionIdentity(operationId, userId, vaultId, email);
    this.ctx.storage.transactionSync(() => {
      const row = this.sql.exec<{ user_id: string | null; vault_id: string | null; email: string | null; generation: string | null; state: string }>(
        `SELECT user_id,vault_id,email,generation,state FROM invite_deletion_receipts WHERE operation_id=?`, operationId,
      ).toArray()[0];
      if (!row) throw new AppError("unavailable", "invite deletion requires capture");
      if (row.state === "closed") { this.requireRedactedInviteReceipt(row); return; }
      if (row.user_id !== userId || row.vault_id !== vaultId || row.email !== normalized || row.state !== "removed")
        throw new AppError("conflict", "invite deletion changed; retry cleanup");
      this.sql.exec(`UPDATE invite_deletion_receipts SET user_id=NULL,vault_id=NULL,email=NULL,generation=NULL,state='closed' WHERE operation_id=? AND state='removed'`, operationId);
    });
  }

  async listInvites(): Promise<{ email: string; createdAt: number }[]> {
    return this.sql
      .exec<{ email: string; created_at: number }>(
        `SELECT email, created_at FROM invites ORDER BY email`,
      )
      .toArray()
      .map((r) => ({ email: r.email, createdAt: r.created_at }));
  }

  /** Close the global generation and permanently seal all its target dispatches. */
  private async prepareFencedIdentityRemoval(userId: string): Promise<{ provider: string; subject: string; generation: string }[] | null> {
    const identities = this.sql.exec<{ provider: string; subject: string; generation: string | null; placement_owner: string | null }>(
      `SELECT i.provider,i.subject,p.generation,p.user_id AS placement_owner FROM identities i LEFT JOIN placement_identities p ON p.provider=i.provider AND p.subject=i.subject WHERE i.user_id=?`, userId,
    ).toArray();
    const fenced = identities.filter((identity) => identity.generation !== null);
    const enabled = (this.env as Env & { PLACEMENT_FENCE_ENABLED?: string }).PLACEMENT_FENCE_ENABLED === "true" && identities.some((identity) => syntheticPlacementIdentity(identity.provider, identity.subject));
    if (!fenced.length && !enabled) return null;
    if (!identities.length || fenced.length !== identities.length)
      throw new AppError("unavailable", "legacy account placement requires review");
    if (fenced.some((identity) => identity.placement_owner !== userId))
      throw new AppError("unavailable", "account placement requires review");
    const global = directory(this.env);
    for (const identity of fenced) {
      const generation = identity.generation!;
      const attempts = await global.closePlacementHome(identity.provider, identity.subject, generation, userId);
      for (const attempt of attempts) {
        const target = attempt.shard === null ? global : directoryByName(this.env, `directory-${attempt.shard}`);
        const sealed = await target.sealPlacementAttempt(attempt);
        await global.settlePlacementAttempt(identity.provider, identity.subject, attempt, sealed.userId);
      }
    }
    return fenced.map((identity) => ({ ...identity, generation: identity.generation! }));
  }

  /** Persist the release acknowledgement before any later deletion step. */
  private async releaseGoogleShardHome(userId: string, subject: string, shard: number): Promise<void> {
    const row = this.sql.exec<{ state: string; fence_epoch: number | null }>(
      `SELECT state,fence_epoch FROM shard_deletion_releases WHERE user_id=? AND provider='google' AND subject=?`, userId, subject,
    ).toArray()[0];
    if (row?.state === "acknowledged" && Number.isSafeInteger(row.fence_epoch) && row.fence_epoch! > 0) return;
    if (!row) this.ctx.storage.transactionSync(() => {
      const current = this.sql.exec(`SELECT i.user_id FROM identities i JOIN users u ON u.user_id=i.user_id WHERE i.user_id=? AND i.provider='google' AND i.subject=? AND u.state='deleting'`, userId, subject).toArray();
      if (current.length !== 1) throw new AppError("gone", "account deletion changed");
      this.sql.exec(`INSERT OR IGNORE INTO shard_deletion_releases(user_id,provider,subject,state) VALUES (?,'google',?,'pending')`, userId, subject);
    });
    // A lost reply can cause a second, conservative epoch bump. No career
    // content or permanent per-user receipt remains in the global Directory.
    const epoch = await directory(this.env).forgetGoogleShardHomeV3(subject, shard, userId);
    if (!Number.isSafeInteger(epoch) || epoch <= 0)
      throw new AppError("unavailable", "account placement requires review");
    this.sql.exec(`UPDATE shard_deletion_releases SET state='acknowledged',fence_epoch=MAX(COALESCE(fence_epoch,0),?) WHERE user_id=? AND provider='google' AND subject=?`, epoch, userId, subject);
  }

  /**
   * Close deleting vaults and sweep their files. After SWEEP_DELAY_MS, check
   * the stored owner again, sweep once more, then destroy the Vault and remove
   * the Directory rows. Unresolved operations remain pending for retry.
   */
  async alarm(): Promise<void> {
    // An external call can remain unresolved. Keep a durable retry before any
    // such call; a final harmless idle alarm is allowed to consume itself.
    const billingAt = this.billing.nextPendingAt();
    if (
      (this.isGlobal && (this.inviteCoordinator.active() || this.inviteRevocation.active())) ||
      this.vaultsIn("deleting").length > 0 ||
      this.vaultsIn("swept").length > 0 ||
      this.sql.exec(`SELECT vault_id FROM retired_vaults LIMIT 1`).toArray().length > 0
    ) await this.scheduleAt(Date.now() + RETRY_MS);
    else if (billingAt !== null) await this.scheduleAt(Math.max(Date.now() + RETRY_MS, billingAt));
    // Billing can wait on a provider indefinitely. Start deletion work while
    // it is in flight so an unrelated account's inbox cannot postpone erasure
    // or leave known subscriptions running. This does not treat that billing
    // request as settled; the alarm still awaits it before rescheduling.
    const inventory = this.isGlobal && this.inviteCoordinator.active()
      ? this.inviteCoordinator.resume().catch(() => { console.error("invitation inventory pending", { code: "inventory_unavailable" }); })
      : Promise.resolve();
    const revocation = this.isGlobal && this.inviteRevocation.active()
      ? this.inviteRevocation.resume().catch(() => { console.error("invitation revocation pending", { code: "revocation_unavailable" }); })
      : Promise.resolve();
    const billing = this.billing.reconcile().catch(() => {
      console.error("billing reconciliation pending", {
        code: "billing_unavailable",
      });
    });
    // Snapshot each lane before starting external work: a vault may only run
    // its final sweep here if it was already swept at the start of this alarm.
    const deleting = this.vaultsIn("deleting");
    const sweptBefore = this.vaultsIn("swept");
    const retiredBefore = this.sql
      .exec<RetiredVaultDbRow>(
        `SELECT * FROM retired_vaults`,
      )
      .toArray();
    // A retirement can yield many times. Give legacy rows an incarnation
    // before the first such yield so stale completions cannot change a row
    // deleted and recreated with the same ID and owner.
    for (const row of retiredBefore) {
      if (row.generation === null) {
        const generation = crypto.randomUUID();
        this.sql.exec(`UPDATE retired_vaults SET generation=? WHERE vault_id=? AND generation IS NULL`, generation, row.vault_id);
        row.generation = generation;
      }
    }
    // Each unresolved operation occupies one slot; the remaining slots keep
    // processing independent accounts without treating it as settled.
    const deletion = eachConcurrent(deleting, async (v) => {
      try {
        await this.erase(v.vault_id);
      } catch (e) {
        console.error("deletion step failed", {
          vaultId: v.vault_id,
          code: logErrorCode(e),
        });
      }
    });
    const retirement = eachConcurrent(retiredBefore, async (retired) => {
      try {
        await this.retireVault(retired);
      } catch {
        console.error("retirement pending", { vaultId: retired.vault_id });
      }
    });
    // Existing swept accounts can complete independently of a stalled active
    // deletion or retirement. Neither lane may settle another lane's fence.
    const finalization = (async () => {
      const attempted = await this.finalizeSwept(sweptBefore);
      // A previously swept account may have been waiting for its own retired
      // Vault. Retry only that original snapshot once retirement finishes,
      // without waiting for unrelated deleting Vaults to finish.
      await retirement;
      const afterRetirement = await this.finalizeSwept(sweptBefore.filter((v) => !attempted.has(v.vault_id)));
      for (const id of afterRetirement) attempted.add(id);
      return attempted;
    })();
    const outcomes = await Promise.allSettled([billing, deletion, retirement, finalization, inventory, revocation]);
    const failure = outcomes.find((outcome) => outcome.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    const attempted = (outcomes[3] as PromiseFulfilledResult<Set<string>>).value;
    // Preserve the zero-delay case: once every lane has finished, newly swept
    // vaults and accounts previously blocked by a retirement can finalize.
    await this.finalizeSwept(this.vaultsIn("swept").filter((v) => !attempted.has(v.vault_id)));
    await this.scheduleNext();
  }

  private requireRetiredCurrent(row: RetiredVaultDbRow): void {
    if (this.env.VAULT.idFromString(row.vault_id).toString() !== row.vault_id ||
        !row.generation || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.generation) ||
        !this.sql.exec(`SELECT vault_id FROM retired_vaults WHERE vault_id=? AND user_id=? AND state=? AND generation=? AND swept_at IS ?`,
          row.vault_id, row.user_id, row.state, row.generation, row.swept_at).toArray().length ||
        this.sql.exec(`SELECT vault_id FROM vaults WHERE vault_id=?`, row.vault_id).toArray().length)
      throw new AppError("unavailable", "retired vault identity requires review");
  }

  private requireRetiredUnchanged(row: RetiredVaultDbRow): void {
    this.requireRetiredCurrent(row);
    if (this.sql.exec(`SELECT operation_id FROM vault_replacements WHERE target_id=? AND state='preparing'`, row.vault_id).toArray().length)
      throw new AppError("unavailable", "retired vault identity requires review");
  }

  private async retireVault(row: RetiredVaultDbRow): Promise<void> {
    // Before this protocol, account deletion could register a target as
    // retired while leaving its replacement marked preparing. Cancel only
    // the owning deleting account's operation; ambiguous references stay
    // pending and may not authorize an R2 sweep.
    this.requireRetiredCurrent(row);
    this.sql.exec(`UPDATE vault_replacements SET state='cancelled' WHERE target_id=? AND user_id=? AND state='preparing' AND EXISTS (SELECT 1 FROM users WHERE user_id=? AND state='deleting')`,
      row.vault_id, row.user_id, row.user_id);
    this.requireRetiredUnchanged(row);
    if (row.state !== "deleting" && row.state !== "awaiting_final_sweep")
      throw new AppError("unavailable", "retired vault requires review");
    if (row.state === "awaiting_final_sweep") {
      if (!validSweepTime(row.swept_at)) throw new AppError("unavailable", "retired vault sweep time requires review");
      if (row.swept_at > Date.now() - this.sweepDelay()) return;
    }
    const stub = this.env.VAULT.get(this.env.VAULT.idFromString(row.vault_id));
    await stub.quiesceForRetirement(row.user_id);
    this.requireRetiredUnchanged(row);
    try {
      await stopKnownVaultRuns(this.env, await stub.knownRunsForRetirement(row.user_id));
    } catch (error) {
      console.error("preliminary retired workflow cleanup pending", { code: logErrorCode(error) });
    }
    this.requireRetiredUnchanged(row);
    this.requireInitializationSettled(row.vault_id);
    const runs = await stub.closeForRetirement(row.user_id);
    this.requireRetiredUnchanged(row);
    await stopVaultRuns(this.env, runs);
    this.requireRetiredUnchanged(row);
    // Recheck the persisted Vault owner immediately before the R2 operation.
    await stub.quiesceForRetirement(row.user_id);
    this.requireRetiredUnchanged(row);
    await deletePrefix(this.env.FILES, vaultPrefix(row.vault_id));
    this.requireRetiredUnchanged(row);
    if (row.state === "deleting") {
      const sweptAt = Date.now();
      this.sql.exec(`UPDATE retired_vaults SET state='awaiting_final_sweep',swept_at=? WHERE vault_id=? AND user_id=? AND state='deleting' AND generation=?`,
        sweptAt, row.vault_id, row.user_id, row.generation);
      // With a zero delay the second sweep may happen in this same alarm,
      // but only after the first one has completed and its phase is durable.
      if (this.sweepDelay() === 0)
        await this.retireVault({ ...row, state: "awaiting_final_sweep", swept_at: sweptAt });
      return;
    }
    await stub.destroyForRetirement(row.user_id);
    this.requireRetiredUnchanged(row);
    this.sql.exec(`DELETE FROM retired_vaults WHERE vault_id=? AND user_id=? AND state='awaiting_final_sweep' AND generation=?`,
      row.vault_id, row.user_id, row.generation);
  }

  private requireFinalizationUnchanged(row: VaultDbRow): void {
    const { vault_id: vaultId, user_id: userId, swept_at: sweptAt, final_generation: generation, final_phase: phase, invite_closed: inviteClosed, invite_operation: inviteOperation } = row;
    if (!validSweepTime(sweptAt) || this.env.VAULT.idFromString(vaultId).toString() !== vaultId ||
        !generation || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(generation) ||
        !inviteOperation || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(inviteOperation) ||
        (phase !== "awaiting" && phase !== "destroyed") || (inviteClosed !== 0 && inviteClosed !== 1) || !this.sql.exec(
      `SELECT v.vault_id FROM vaults v JOIN users u ON u.user_id=v.user_id JOIN account_final_sweeps a ON a.vault_id=v.vault_id JOIN account_invite_deletions i ON i.user_id=v.user_id AND i.vault_id=v.vault_id
       WHERE v.vault_id=? AND v.user_id=? AND u.email=? AND u.state='deleting' AND v.state='swept' AND v.swept_at=?
       AND a.user_id=? AND a.swept_at=? AND a.generation=? AND a.phase=? AND a.invite_closed=? AND i.operation_id=?`,
      vaultId, userId, row.email, sweptAt, userId, sweptAt, generation, phase, inviteClosed, inviteOperation,
    ).toArray().length || this.sql.exec(
      `SELECT vault_id FROM retired_vaults WHERE user_id=? OR vault_id=?`,
      userId, vaultId,
    ).toArray().length)
      throw new AppError("unavailable", "account deletion changed; retry cleanup");
  }

  private async finalizeSwept(vaults: VaultDbRow[]): Promise<Set<string>> {
    const attempted = new Set<string>();
    const due = Date.now() - this.sweepDelay();
    await eachConcurrent(vaults, async (v) => {
      if (!validSweepTime(v.swept_at)) {
        attempted.add(v.vault_id);
        console.error("final sweep pending", { vaultId: v.vault_id, code: "invalid_sweep_time" });
        return;
      }
      if (
        v.swept_at > due ||
        this.sql
          .exec(
            `SELECT vault_id FROM retired_vaults WHERE user_id=? OR vault_id=?`,
            v.user_id,
            v.vault_id,
          )
          .toArray().length
      )
        return;
      attempted.add(v.vault_id);
      try {
        this.requireFinalizationUnchanged(v);
        // The coordinator commits the captured invite incarnation before any
        // later cleanup can yield. Retried capture uses the same receipt.
        await directory(this.env).captureInviteForDeletion(v.invite_operation!, v.user_id, v.vault_id, v.email);
        this.requireFinalizationUnchanged(v);
        if (v.final_phase === "awaiting") {
          const stub = this.env.VAULT.get(this.env.VAULT.idFromString(v.vault_id));
          await stub.quiesceForAccountDeletion(v.user_id);
          this.requireFinalizationUnchanged(v);
          await deletePrefix(this.env.FILES, vaultPrefix(v.vault_id));
          this.requireFinalizationUnchanged(v);
          // Persist only an acknowledged destruction. If its reply is lost,
          // an empty Vault does not prove ownership and the row remains pending.
          await stub.destroyForAccountDeletion(v.user_id);
          this.ctx.storage.transactionSync(() => {
            this.requireFinalizationUnchanged(v);
            this.sql.exec(`UPDATE account_final_sweeps SET phase='destroyed' WHERE vault_id=? AND user_id=? AND generation=? AND swept_at=? AND phase='awaiting'`,
              v.vault_id, v.user_id, v.final_generation, v.swept_at);
          });
          v.final_phase = "destroyed";
        }
        this.requireFinalizationUnchanged(v);
        let finalizations = this.sql.exec<{ provider: string; subject: string; generation: string }>(
          `SELECT provider,subject,generation FROM placement_finalizations WHERE user_id=?`, v.user_id,
        ).toArray();
        const fenced = finalizations.length ? null : await this.prepareFencedIdentityRemoval(v.user_id);
        // The placement RPC can yield while this deletion is replaced or a
        // retirement is created. Do not dispatch the next external cleanup
        // using a stale owner or final-sweep incarnation.
        this.requireFinalizationUnchanged(v);
        const shard = /^s(\d+):/i.exec(v.user_id);
        await directory(this.env).removeCapturedInvite(v.invite_operation!, v.user_id, v.vault_id, v.email, v.final_generation!);
        this.requireFinalizationUnchanged(v);
        if (v.stripe_customer)
          await cleanupBillingCustomer(this.env, v.stripe_customer, fetch, parseCheckoutIds(v.stripe_checkout_sessions));
        else if (parseCheckoutIds(v.stripe_checkout_sessions).length)
          throw new AppError("unavailable", "checkout customer requires operator review");
        this.requireFinalizationUnchanged(v);
        await revokeOAuthUserGrants(this.env, v.user_id);
        // A newly discovered retirement must stop before initiating any
        // identity-home release. An in-flight release cannot be recalled.
        this.requireFinalizationUnchanged(v);
        if (fenced) {
          // Remove the target identity before releasing its global claim. The
          // durable outbox keeps the user's deletion retryable across a crash.
          this.ctx.storage.transactionSync(() => {
            for (const identity of fenced) {
              this.sql.exec(`INSERT INTO placement_finalizations(user_id,vault_id,provider,subject,generation) VALUES (?,?,?,?,?)`, v.user_id, v.vault_id, identity.provider, identity.subject, identity.generation);
              this.sql.exec(`DELETE FROM placement_identities WHERE provider=? AND subject=? AND generation=?`, identity.provider, identity.subject, identity.generation);
            }
            this.sql.exec(`DELETE FROM identities WHERE user_id=?`, v.user_id);
            // Keep opaque sealed tombstones forever so delayed dispatches cannot recreate the account.
            this.sql.exec(`UPDATE placement_receipts SET user_id=NULL WHERE user_id=? AND state='sealed'`, v.user_id);
          });
          finalizations = fenced;
        }
        for (const identity of finalizations) {
          this.requireFinalizationUnchanged(v);
          await directory(this.env).releasePlacementHome(identity.provider, identity.subject, identity.generation, v.user_id);
        }
        // Release only after the other external cleanup has succeeded. This
        // narrows, but does not eliminate, the cross-object interval before
        // the local identity is deleted below.
        if (shard && !fenced && !finalizations.length) {
          for (const identity of this.sql
            .exec<{ provider: string; subject: string }>(
              `SELECT provider,subject FROM identities WHERE user_id=?`, v.user_id,
            ).toArray())
            if (identity.provider === "google") {
              this.requireFinalizationUnchanged(v);
              await this.releaseGoogleShardHome(v.user_id, identity.subject, Number(shard[1]));
            } else {
              this.requireFinalizationUnchanged(v);
              await directory(this.env).forgetIdentityHome(identity.provider, identity.subject, Number(shard[1]), v.user_id);
            }
        }
        if (!v.invite_closed) {
          this.requireFinalizationUnchanged(v);
          await directory(this.env).closeInviteDeletion(v.invite_operation!, v.user_id, v.vault_id, v.email);
          this.ctx.storage.transactionSync(() => {
            this.requireFinalizationUnchanged(v);
            this.sql.exec(`UPDATE account_final_sweeps SET invite_closed=1 WHERE vault_id=? AND user_id=? AND generation=? AND invite_closed=0`,
              v.vault_id, v.user_id, v.final_generation);
          });
          v.invite_closed = 1;
        }
        this.ctx.storage.transactionSync(() => {
          // External cleanup yields. A newly observed retired vault or a
          // changed account must prevent this stale finalization snapshot
          // from removing the Directory rows.
          this.requireFinalizationUnchanged(v);
          // A newly observed Google identity must also have an acknowledged
          // release; never let a stale scan authorize its deletion.
          if (this.isShard && this.sql.exec(`SELECT i.subject FROM identities i WHERE i.user_id=? AND i.provider='google' AND NOT EXISTS (SELECT 1 FROM shard_deletion_releases r WHERE r.user_id=i.user_id AND r.provider=i.provider AND r.subject=i.subject AND r.state='acknowledged' AND r.fence_epoch > 0)`, v.user_id).toArray().length)
            throw new AppError("unavailable", "account placement requires review");
          if (this.isShard) {
            const rows = this.sql.exec<{ fence_epoch: number }>(`SELECT r.fence_epoch FROM identities i JOIN shard_deletion_releases r ON r.user_id=i.user_id AND r.provider=i.provider AND r.subject=i.subject WHERE i.user_id=? AND i.provider='google'`, v.user_id).toArray();
            if (rows.some((row) => !Number.isSafeInteger(row.fence_epoch) || row.fence_epoch <= 0))
              throw new AppError("unavailable", "account placement requires review");
            const floor = Math.max(this.readShardAuthFloor(), ...rows.map((row) => row.fence_epoch));
            this.sql.exec(`UPDATE meta SET value=? WHERE key='shard_auth_floor'`, String(floor));
            this.sql.exec(`INSERT INTO shard_identity_delete_marker(user_id) VALUES (?)`, v.user_id);
            this.sql.exec(`INSERT INTO shard_google_delete_v3_marker(user_id) VALUES (?)`, v.user_id);
          }
          try {
            this.billing.erase(v.user_id, v.stripe_customer ?? undefined);
            this.sql.exec(
              `DELETE FROM identity_homes WHERE (provider,subject) IN (SELECT provider,subject FROM identities WHERE user_id=?)`,
              v.user_id,
            );
            this.sql.exec(
              `DELETE FROM vault_replacements WHERE user_id=?`,
              v.user_id,
            );
            this.sql.exec(`DELETE FROM identities WHERE user_id = ?`, v.user_id);
            this.sql.exec(`DELETE FROM vaults WHERE vault_id = ?`, v.vault_id);
            this.sql.exec(`DELETE FROM account_final_sweeps WHERE vault_id=? AND user_id=? AND generation=? AND phase='destroyed'`,
              v.vault_id, v.user_id, v.final_generation);
            this.sql.exec(`DELETE FROM account_invite_deletions WHERE vault_id=? AND user_id=? AND operation_id=?`,
              v.vault_id, v.user_id, v.invite_operation);
            this.sql.exec(`DELETE FROM users WHERE user_id = ?`, v.user_id);
            this.sql.exec(`DELETE FROM placement_finalizations WHERE user_id=?`, v.user_id);
            this.sql.exec(`DELETE FROM shard_deletion_releases WHERE user_id=?`, v.user_id);
          } finally {
            if (this.isShard) {
              this.sql.exec(`DELETE FROM shard_google_delete_v3_marker WHERE user_id=?`, v.user_id);
              this.sql.exec(`DELETE FROM shard_identity_delete_marker WHERE user_id=?`, v.user_id);
            }
          }
        });
      } catch (e) {
        console.error("final sweep failed", {
          vaultId: v.vault_id,
          code: logErrorCode(e),
        });
      }
    });
    return attempted;
  }

  private requireDeletingUnchanged(vaultId: string, owner: DeletingOwner): void {
    if (!this.sql.exec(`SELECT v.vault_id FROM vaults v JOIN users u ON u.user_id=v.user_id JOIN account_invite_deletions i ON i.user_id=v.user_id AND i.vault_id=v.vault_id WHERE v.vault_id=? AND v.user_id=? AND u.email=? AND i.operation_id=? AND v.state='deleting' AND u.state='deleting'`, vaultId, owner.user_id, owner.email, owner.operation_id).toArray().length)
      throw new AppError("unavailable", "account deletion changed; retry cleanup");
  }

  private async erase(vaultId: string): Promise<void> {
    const id = this.env.VAULT.idFromString(vaultId);
    if (id.toString() !== vaultId) throw new AppError("unavailable", "vault identity requires review");
    const owner = this.sql.exec<DeletingOwner>(`SELECT v.user_id,u.email,i.operation_id FROM vaults v JOIN users u ON u.user_id=v.user_id JOIN account_invite_deletions i ON i.user_id=v.user_id AND i.vault_id=v.vault_id WHERE v.vault_id=? AND v.state='deleting'`, vaultId).toArray()[0];
    if (!owner) throw new AppError("unavailable", "account deletion changed; retry cleanup");
    this.requireDeletingUnchanged(vaultId, owner);
    await directory(this.env).captureInviteForDeletion(owner.operation_id, owner.user_id, vaultId, owner.email);
    this.requireDeletingUnchanged(vaultId, owner);
    await this.env.VAULT.get(id).quiesceForAccountDeletion(owner.user_id);
    this.requireDeletingUnchanged(vaultId, owner);
    // Do not let an unrelated unresolved dispatch indefinitely postpone
    // cancellation of already-known billing or removal of visible objects.
    // These attempts are provisional: they cannot settle a fence or mark a
    // vault swept, and the authoritative billing check and R2 sweep below are
    // repeated only after close succeeds. Use separate stubs so a failed RPC
    // does not poison another concurrent operation.
    const [billingAttempt, sweepAttempt, runsAttempt, closeAttempt] = await Promise.allSettled([
      this.preliminaryBillingCleanup(vaultId, owner),
      deletePrefix(this.env.FILES, vaultPrefix(vaultId)),
      (async () => {
        const known = await this.env.VAULT.get(id).knownRunsForAccountDeletion(owner.user_id);
        this.requireDeletingUnchanged(vaultId, owner);
        await stopKnownVaultRuns(this.env, known);
      })(),
      (async () => {
        this.requireInitializationSettled(vaultId);
        return this.env.VAULT.get(id).closeForAccountDeletion(owner.user_id);
      })(),
    ]);
    if (billingAttempt.status === "rejected")
      console.error("preliminary billing cleanup pending", { code: logErrorCode(billingAttempt.reason) });
    if (sweepAttempt.status === "rejected")
      console.error("preliminary source cleanup pending", { code: logErrorCode(sweepAttempt.reason) });
    if (runsAttempt.status === "rejected")
      console.error("preliminary workflow cleanup pending", { code: logErrorCode(runsAttempt.reason) });
    if (closeAttempt.status === "rejected") throw closeAttempt.reason;
    this.requireDeletingUnchanged(vaultId, owner);
    const runs = closeAttempt.value;
    const stub = this.env.VAULT.get(id);
    const customer = await stub.billingCustomerForAccountDeletion(owner.user_id);
    this.requireDeletingUnchanged(vaultId, owner);
    const newCheckoutIds = await stub.billingCheckoutSessionsForAccountDeletion(owner.user_id);
    this.requireDeletingUnchanged(vaultId, owner);
    const previous = this.sql.exec<{ stripe_customer: string | null; stripe_checkout_sessions: string }>(
      `SELECT stripe_customer, stripe_checkout_sessions FROM vaults WHERE vault_id=?`, vaultId,
    ).one();
    if (previous.stripe_customer && customer && previous.stripe_customer !== customer)
      throw new AppError("unavailable", "billing customer requires operator review");
    const knownCustomer = customer ?? previous.stripe_customer;
    const checkoutIds = [...new Set([...parseCheckoutIds(previous.stripe_checkout_sessions), ...newCheckoutIds])];
    if (checkoutIds.length > 2000) throw new AppError("unavailable", "checkout history requires operator review");
    this.sql.exec(
      `UPDATE vaults SET stripe_customer=?, stripe_checkout_sessions=? WHERE vault_id=?`,
      knownCustomer, JSON.stringify(checkoutIds), vaultId,
    );
    if (!knownCustomer && checkoutIds.length)
      throw new AppError("unavailable", "checkout customer requires operator review");
    if (knownCustomer) await cleanupBillingCustomer(this.env, knownCustomer, fetch, checkoutIds);
    this.requireDeletingUnchanged(vaultId, owner);
    await stopVaultRuns(this.env, runs);
    this.requireDeletingUnchanged(vaultId, owner);
    await revokeOAuthUserGrants(this.env, owner.user_id);
    this.requireDeletingUnchanged(vaultId, owner);
    await stub.quiesceForAccountDeletion(owner.user_id);
    this.requireDeletingUnchanged(vaultId, owner);
    await deletePrefix(this.env.FILES, vaultPrefix(vaultId));
    this.requireDeletingUnchanged(vaultId, owner);
    // Preserve the persisted owner through the delayed second sweep.  The
    // proof row and phase change commit together; a legacy swept row cannot
    // be backfilled from an already destroyed Vault.
    const sweptAt = Date.now(), generation = crypto.randomUUID();
    this.ctx.storage.transactionSync(() => {
      this.requireDeletingUnchanged(vaultId, owner);
      this.sql.exec(`INSERT INTO account_final_sweeps(vault_id,user_id,generation,swept_at,phase) VALUES (?,?,?,?,'awaiting')`,
        vaultId, owner.user_id, generation, sweptAt);
      this.sql.exec(`UPDATE vaults SET state='swept',swept_at=?,updated_at=? WHERE vault_id=? AND user_id=? AND state='deleting'`,
        sweptAt, sweptAt, vaultId, owner.user_id);
    });
  }

  /** Best effort only: never create or infer an unknown billing customer. */
  private async preliminaryBillingCleanup(vaultId: string, owner: DeletingOwner): Promise<void> {
    const id = this.env.VAULT.idFromString(vaultId);
    const known = await this.env.VAULT.get(id).knownBillingForAccountDeletion(owner.user_id);
    this.requireDeletingUnchanged(vaultId, owner);
    const previous = this.sql.exec<{ stripe_customer: string | null; stripe_checkout_sessions: string }>(
      `SELECT stripe_customer, stripe_checkout_sessions FROM vaults WHERE vault_id=?`, vaultId,
    ).one();
    if (previous.stripe_customer && known.customer && previous.stripe_customer !== known.customer)
      throw new AppError("unavailable", "billing customer requires operator review");
    const customer = known.customer ?? previous.stripe_customer;
    const sessions = [...new Set([...parseCheckoutIds(previous.stripe_checkout_sessions), ...known.checkoutIds])];
    if (sessions.length > 2000) throw new AppError("unavailable", "checkout history requires operator review");
    if (!customer && sessions.length) throw new AppError("unavailable", "checkout customer requires operator review");
    // Persist the exact IDs before any network I/O, even if a later close or
    // destruction acknowledgement is lost.
    this.sql.exec(`UPDATE vaults SET stripe_customer=?, stripe_checkout_sessions=? WHERE vault_id=?`, customer, JSON.stringify(sessions), vaultId);
    if (customer) await cleanupBillingCustomer(this.env, customer, fetch, sessions);
  }

  private sweepDelay(): number {
    const n = Number(this.env.SWEEP_DELAY_MS);
    return Number.isFinite(n) && n >= 0 ? n : 3_600_000;
  }

  private async scheduleNext(): Promise<void> {
    const now = Date.now();
    const candidates: number[] = [];
    if (this.isGlobal && (this.inviteCoordinator.active() || this.inviteRevocation.active())) candidates.push(now + RETRY_MS);
    if (
      this.sql.exec(`SELECT vault_id FROM retired_vaults LIMIT 1`).toArray()
        .length
    )
      candidates.push(now + RETRY_MS);
    const billingAt = this.billing.nextPendingAt(now);
    if (billingAt !== null) candidates.push(Math.max(now + RETRY_MS, billingAt));
    if (this.vaultsIn("deleting").length > 0)
      candidates.push(now + RETRY_MS);
    const swept = this.vaultsIn("swept").map((v) =>
      validSweepTime(v.swept_at) && Number.isSafeInteger(v.swept_at + this.sweepDelay())
        ? v.swept_at + this.sweepDelay() : now + RETRY_MS,
    );
    // An overdue final sweep that failed or is blocked by retirement must
    // back off. Scheduling its past due time would immediately fire alarms
    // in a loop and can starve unrelated work.
    candidates.push(...swept.map((due) => due <= now ? now + RETRY_MS : due));
    if (candidates.length > 0) return this.scheduleAt(Math.min(...candidates));
  }

  private async scheduleAt(when: number): Promise<void> {
    await this.ctx.storage.transaction(async () => {
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > when)
        await this.ctx.storage.setAlarm(when);
    });
  }

  private vaultsIn(state: "deleting" | "swept"): VaultDbRow[] {
    return this.sql
      .exec<VaultDbRow>(
        `SELECT v.vault_id, v.user_id, u.email, v.hint, v.state, v.swept_at, v.updated_at, v.stripe_customer, v.stripe_checkout_sessions,
                a.generation AS final_generation, a.phase AS final_phase, a.invite_closed, i.operation_id AS invite_operation
         FROM vaults v JOIN users u ON u.user_id = v.user_id LEFT JOIN account_final_sweeps a ON a.vault_id=v.vault_id
         LEFT JOIN account_invite_deletions i ON i.user_id=v.user_id AND i.vault_id=v.vault_id WHERE v.state = ?`,
        state,
      )
      .toArray();
  }

  private findAccount(provider: string, subject: string): AccountRow | null {
    return (
      this.sql
        .exec<AccountRow>(
          `SELECT u.user_id, u.state AS user_state, v.vault_id, v.state AS vault_state, v.hint
           FROM identities i JOIN users u ON u.user_id = i.user_id JOIN vaults v ON v.user_id = u.user_id
           WHERE i.provider = ? AND i.subject = ?`,
          provider,
          subject,
        )
        .toArray()[0] ?? null
    );
  }

  private isInvited(email: string): boolean {
    return (
      this.sql
        .exec(`SELECT email FROM invites WHERE email = ?`, email)
        .toArray().length > 0
    );
  }
}

/**
 * Stop every locally known run even when another run is unavailable or its
 * kind is unknown. This is provisional: a missing instance does not settle
 * an in-flight create, and only close() can authorize final destruction.
 */
async function stopKnownVaultRuns(
  env: Env,
  runs: { distill: string[]; tailor: string[]; other?: { kind: string; id: string }[] },
): Promise<void> {
  const targets = [
    ...runs.distill.map((id) => ({ kind: "distill", id })),
    ...runs.tailor.map((id) => ({ kind: "tailor", id })),
    ...(runs.other ?? []),
  ];
  let firstFailure: unknown;
  let failed = false;
  for (let offset = 0; offset < targets.length; offset += 4) {
    const results = await Promise.allSettled(targets.slice(offset, offset + 4).map((target) =>
      stopVaultRuns(env, { distill: [], tailor: [], other: [target] }),
    ));
    for (const result of results)
      if (result.status === "rejected" && !failed) {
        failed = true;
        firstFailure = result.reason;
      }
  }
  if (failed) throw firstFailure ?? new AppError("unavailable", "workflow cleanup failed");
}

/** Both account deletion and vault retirement must understand every run kind. */
export async function stopVaultRuns(
  env: Env,
  runs: { distill: string[]; tailor: string[]; other?: { kind: string; id: string }[] },
): Promise<void> {
  const bindings: Record<string, string> = {
    distill: "DISTILL",
    tailor: "TAILOR",
    refine: "DOCUMENTS",
    letter: "DOCUMENTS",
    prep: "DOCUMENTS",
    questions: "DOCUMENTS",
    reembed: "REEMBED",
  };
  await stopRuns(env.DISTILL, runs.distill);
  await stopRuns(env.TAILOR, runs.tailor);
  for (const run of runs.other ?? []) {
    const binding = bindings[run.kind];
    const workflow = binding
      ? (env as unknown as Record<string, Workflow | undefined>)[binding]
      : undefined;
    if (!workflow)
      throw new AppError("unavailable", "a workflow required for deletion is not configured");
    await stopRuns(workflow, [run.id]);
  }
}

/** Only explicit absence or a confirmed terminal status can complete this deletion step. */
export async function stopRuns(
  workflow: Workflow,
  ids: string[],
): Promise<void> {
  for (const id of new Set(ids)) {
    try {
      const instance = await workflow.get(id);
      const { status } = await instance.status();
      if (
        status === "complete" ||
        status === "errored" ||
        status === "terminated"
      ) {
        await instance.delete();
        continue;
      }
      try {
        await instance.terminate();
      } catch (error) {
        // Completion may race termination. A second status read must confirm it;
        // connection errors and overload must propagate to the deletion alarm.
        const after = await instance.status();
        if (
          after.status !== "complete" &&
          after.status !== "errored" &&
          after.status !== "terminated"
        )
          throw error;
      }
      await instance.delete();
    } catch (error) {
      if (!isMissingWorkflowInstance(error, id)) throw error;
    }
  }
}
