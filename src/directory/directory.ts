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
};

type RetiredVaultDbRow = {
  vault_id: string;
  user_id: string;
  state: string;
  swept_at: number | null;
  generation: string | null;
};

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

  async googleAuthEpoch(): Promise<number> {
    if (!this.isGlobal) throw new AppError("invalid", "sign-in coordinator is invalid");
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
      if (this.isGlobal && provider === "google") {
        const text = this.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='global_auth_epoch'`).one().value;
        if (!Number.isSafeInteger(epoch) || epoch! < 0 || !/^(?:0|[1-9]\d*)$/.test(text) || Number(text) !== epoch)
          throw new AppError("conflict", "sign-in is stale; try again");
        this.sql.exec(`INSERT INTO global_auth_marker(slot,epoch) VALUES (1,?)`, epoch!);
        try { return action(); } finally { this.sql.exec(`DELETE FROM global_auth_marker WHERE slot=1`); }
      }
      if (this.isShard && provider === "google") {
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
  async acceptBillingEvent(event: BillingEvent, userId?: string): Promise<void> {
    this.billing.accept(userId, event);
    if (this.billing.pending()) await this.scheduleAt(Date.now());
  }

  /**
   * Finds or creates the user and their vault. Rows are written before the first await, so a
   * second sign-in racing the first finds them and gets the same vault. Safe to repeat.
   */
  async signIn(p: SignInInput): Promise<{ userId: string; vaultId: string; created?: boolean; shardClaimToken?: string | null }> {
    if (p.authExpiryMs !== undefined) requireFreshAuth(p.authExpiryMs);
    if (p.shardClaimToken !== undefined &&
        (p.provider !== "google" || !Number.isInteger(p.homeShard) || p.homeShard! < 0 || p.homeShard! > 15 ||
          !this.ctx.id.equals(this.env.DIRECTORY.idFromName(`directory-${p.homeShard}`)) || typeof p.shardClaimToken !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(p.shardClaimToken)))
      throw new AppError("invalid", "invalid account placement claim");
    // Existing identities also need the original authorization epoch: a
    // stale callback must not attach to a replacement account after erasure.
    if ((this.isGlobal || this.isShard) && p.provider === "google") this.googleWrite(p.provider, p.authEpoch, () => {});
    const email = p.email.trim().toLowerCase();
    let row = this.findAccount(p.provider, p.subject);
    let created = false;
    const storedShardClaim = (userId: string) => this.sql.exec<{ token: string }>(
      `SELECT token FROM shard_identity_claim_tokens WHERE provider=? AND subject=? AND user_id=?`, p.provider, p.subject, userId,
    ).toArray()[0]?.token ?? null;
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
        this.sql.exec(
          `INSERT INTO users (user_id, email, state, created_at) VALUES (?, ?, 'active', ?)`,
          userId,
          email,
          now,
        );
        this.sql.exec(
          `INSERT INTO identities (provider, subject, user_id) VALUES (?, ?, ?)`,
          p.provider,
          p.subject,
          userId,
        );
        if (p.shardClaimToken)
          this.sql.exec(`INSERT INTO shard_identity_claim_tokens (provider,subject,user_id,token) VALUES (?,?,?,?)`, p.provider, p.subject, userId, p.shardClaimToken);
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
      this.sql.exec(
        `UPDATE vaults SET state = 'active', updated_at = ? WHERE vault_id = ? AND state = 'creating'`,
        Date.now(),
        row.vault_id,
      );
    }
    // Deletion can begin while init is awaiting a different Durable Object.
    const current = this.findAccount(p.provider, p.subject);
    if (
      !current || current.user_state !== "active" ||
      current.vault_state !== "active" || current.vault_id !== row.vault_id
    )
      throw new AppError("forbidden", "this account is being deleted");
    if (p.authExpiryMs !== undefined) requireFreshAuth(p.authExpiryMs);
    const shardClaimToken = storedShardClaim(row.user_id);
    if (p.shardClaimToken && p.shardClaimToken !== shardClaimToken)
      throw new AppError("conflict", "account placement changed; retry sign-in");
    return { userId: row.user_id, vaultId: row.vault_id, ...(p.reportCreation ? { created, shardClaimToken } : {}) };
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
      // A global account can predate placement tracking. A sharded account,
      // however, must have its coordinator claim before a session is issued:
      // an absent home can also mean that the shard has an orphan identity
      // after deletion or an interrupted rollout. Do not recreate it here.
      if (!home) {
        if (directoryNameForUser(userId) !== "global")
          throw new AppError("unavailable", "sharded account placement requires review");
        return;
      }
      if (home.generation && home.user_id === null)
        throw new AppError("unavailable", "registered placement must be settled before binding");
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
      if (verifiedClaim && home.user_id === null)
        this.sql.exec(`INSERT INTO shard_home_bind_claim_marker(provider,subject,token) VALUES (?,?,?)`, provider, subject, shardClaimToken!);
      try {
        this.sql.exec(
          `UPDATE identity_homes SET user_id=? WHERE provider=? AND subject=? AND (user_id IS NULL OR user_id=?)`,
          userId,
          provider,
          subject,
          userId,
        );
      } finally {
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
    return count;
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
      return { active: [...new Set(active.map((v) => v.vault_id))], targets: [...new Set(targets.map((v) => v.vault_id))] };
    });
    // A preparing replacement may still be copying files. Revoke its Vault
    // as well as the active one immediately, rather than waiting for the
    // retirement alarm. The alarm remains responsible for retry and cleanup.
    // Attempt every Vault even if another one is unavailable.
    const results = await Promise.allSettled([
      ...toQuiesce.active.map(async (id) => this.env.VAULT.get(this.env.VAULT.idFromString(id)).quiesce()),
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

  async removeInvite(email: string): Promise<void> {
    this.sql.exec(
      `DELETE FROM invites WHERE email = ?`,
      email.trim().toLowerCase(),
    );
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
   * Erases deleting vaults: close the vault, stop its runs, delete its files, destroy it. After
   * SWEEP_DELAY_MS the files are swept once more, for any upload that raced the deletion, and then
   * the Directory rows go. Each vault is handled on its own, so one failure never blocks the others.
   */
  async alarm(): Promise<void> {
    // An external call can remain unresolved. Keep a durable retry before any
    // such call; a final harmless idle alarm is allowed to consume itself.
    const billingAt = this.billing.nextPendingAt();
    if (
      this.vaultsIn("deleting").length > 0 ||
      this.vaultsIn("swept").length > 0 ||
      this.sql.exec(`SELECT vault_id FROM retired_vaults LIMIT 1`).toArray().length > 0
    ) await this.scheduleAt(Date.now() + RETRY_MS);
    else if (billingAt !== null) await this.scheduleAt(Math.max(Date.now() + RETRY_MS, billingAt));
    // Billing can wait on a provider indefinitely. Start deletion work while
    // it is in flight so an unrelated account's inbox cannot postpone erasure
    // or leave known subscriptions running. This does not treat that billing
    // request as settled; the alarm still awaits it before rescheduling.
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
    const outcomes = await Promise.allSettled([billing, deletion, retirement, finalization]);
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

  private requireFinalizationUnchanged(vaultId: string, userId: string, sweptAt: number | null): void {
    if (!validSweepTime(sweptAt) || this.env.VAULT.idFromString(vaultId).toString() !== vaultId || !this.sql.exec(
      `SELECT vault_id FROM vaults WHERE vault_id=? AND user_id=? AND state='swept' AND swept_at=?`,
      vaultId, userId, sweptAt,
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
        this.requireFinalizationUnchanged(v.vault_id, v.user_id, v.swept_at);
        let finalizations = this.sql.exec<{ provider: string; subject: string; generation: string }>(
          `SELECT provider,subject,generation FROM placement_finalizations WHERE user_id=?`, v.user_id,
        ).toArray();
        const fenced = finalizations.length ? null : await this.prepareFencedIdentityRemoval(v.user_id);
        const shard = /^s(\d+):/i.exec(v.user_id);
        await directory(this.env).removeInvite(v.email);
        if (v.stripe_customer)
          await cleanupBillingCustomer(this.env, v.stripe_customer, fetch, parseCheckoutIds(v.stripe_checkout_sessions));
        else if (parseCheckoutIds(v.stripe_checkout_sessions).length)
          throw new AppError("unavailable", "checkout customer requires operator review");
        await revokeOAuthUserGrants(this.env, v.user_id);
        await deletePrefix(this.env.FILES, vaultPrefix(v.vault_id));
        // A newly discovered retirement must stop before initiating any
        // identity-home release. An in-flight release cannot be recalled.
        this.requireFinalizationUnchanged(v.vault_id, v.user_id, v.swept_at);
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
          this.requireFinalizationUnchanged(v.vault_id, v.user_id, v.swept_at);
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
              this.requireFinalizationUnchanged(v.vault_id, v.user_id, v.swept_at);
              await this.releaseGoogleShardHome(v.user_id, identity.subject, Number(shard[1]));
            } else {
              this.requireFinalizationUnchanged(v.vault_id, v.user_id, v.swept_at);
              await directory(this.env).forgetIdentityHome(identity.provider, identity.subject, Number(shard[1]), v.user_id);
            }
        }
        this.ctx.storage.transactionSync(() => {
          // External cleanup yields. A newly observed retired vault or a
          // changed account must prevent this stale finalization snapshot
          // from removing the Directory rows.
          this.requireFinalizationUnchanged(v.vault_id, v.user_id, v.swept_at);
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

  private async erase(vaultId: string): Promise<void> {
    const id = this.env.VAULT.idFromString(vaultId);
    if (id.toString() !== vaultId) throw new AppError("unavailable", "vault identity requires review");
    await this.env.VAULT.get(id).quiesce();
    // Do not let an unrelated unresolved dispatch indefinitely postpone
    // cancellation of already-known billing or removal of visible objects.
    // These attempts are provisional: they cannot settle a fence or mark a
    // vault swept, and the authoritative billing check and R2 sweep below are
    // repeated only after close succeeds. Use separate stubs so a failed RPC
    // does not poison another concurrent operation.
    const [billingAttempt, sweepAttempt, runsAttempt, closeAttempt] = await Promise.allSettled([
      this.preliminaryBillingCleanup(vaultId),
      deletePrefix(this.env.FILES, vaultPrefix(vaultId)),
      (async () => stopKnownVaultRuns(this.env, await this.env.VAULT.get(id).knownRunsForDeletion()))(),
      (async () => {
        this.requireInitializationSettled(vaultId);
        return this.env.VAULT.get(id).close();
      })(),
    ]);
    if (billingAttempt.status === "rejected")
      console.error("preliminary billing cleanup pending", { code: logErrorCode(billingAttempt.reason) });
    if (sweepAttempt.status === "rejected")
      console.error("preliminary source cleanup pending", { code: logErrorCode(sweepAttempt.reason) });
    if (runsAttempt.status === "rejected")
      console.error("preliminary workflow cleanup pending", { code: logErrorCode(runsAttempt.reason) });
    if (closeAttempt.status === "rejected") throw closeAttempt.reason;
    const runs = closeAttempt.value;
    const stub = this.env.VAULT.get(id);
    const customer = await stub.billingCustomerForDeletion();
    const newCheckoutIds = await stub.billingCheckoutSessionsForDeletion();
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
    await stopVaultRuns(this.env, runs);
    const owner = this.sql
      .exec<{ user_id: string }>(
        `SELECT user_id FROM vaults WHERE vault_id = ?`,
        vaultId,
      )
      .one();
    await revokeOAuthUserGrants(this.env, owner.user_id);
    await deletePrefix(this.env.FILES, vaultPrefix(vaultId));
    // The vault goes last, so a retry after any failure above can still ask it which runs to stop.
    await stub.destroy();
    this.sql.exec(
      `UPDATE vaults SET state = 'swept', swept_at = ?, updated_at = ? WHERE vault_id = ?`,
      Date.now(),
      Date.now(),
      vaultId,
    );
  }

  /** Best effort only: never create or infer an unknown billing customer. */
  private async preliminaryBillingCleanup(vaultId: string): Promise<void> {
    const id = this.env.VAULT.idFromString(vaultId);
    const known = await this.env.VAULT.get(id).knownBillingForDeletion();
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
        `SELECT v.vault_id, v.user_id, u.email, v.hint, v.state, v.swept_at, v.updated_at, v.stripe_customer, v.stripe_checkout_sessions
         FROM vaults v JOIN users u ON u.user_id = v.user_id WHERE v.state = ?`,
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
