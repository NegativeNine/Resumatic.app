import { revokeOAuthUserGrants } from "../worker/mcp";
import { BillingStore } from "./billing";
import { cleanupBillingCustomer, type BillingEvent } from "../worker/billing";
import { directory } from "../shared/stubs";
import { requireMaintenanceFence, shardedUserId } from "../shared/operations";
import { DurableObject } from "cloudflare:workers";
import { AppError } from "../shared/errors";
import { isMissingWorkflowInstance } from "../shared/workflow-errors";
import { deletePrefix, vaultPrefix } from "../shared/r2";
import type { SignInInput, VaultRow } from "../shared/types";
import { migrateDirectory } from "./schema";

/** How soon a failed deletion is retried. */
const RETRY_MS = 60_000;

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
    void ctx.blockConcurrencyWhile(async () =>
      migrateDirectory(this.ctx.storage.sql, (fn) => this.ctx.storage.transactionSync(fn)),
    );
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
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
  async acceptBillingEvent(event: BillingEvent): Promise<void> {
    this.billing.accept(event);
    if (this.billing.pending()) await this.scheduleAt(Date.now());
  }

  /**
   * Finds or creates the user and their vault. Rows are written before the first await, so a
   * second sign-in racing the first finds them and gets the same vault. Safe to repeat.
   */
  async signIn(p: SignInInput): Promise<{ userId: string; vaultId: string }> {
    const email = p.email.trim().toLowerCase();
    let row = this.findAccount(p.provider, p.subject);
    // Routing and this RPC are separate operations. If erasure removed the
    // observed account in between, retry routing instead of recreating it on
    // a potentially stale shard alongside a new account elsewhere.
    if (p.expectedUserId !== undefined && (!row || row.user_id !== p.expectedUserId))
      throw new AppError("conflict", "the account changed; retry sign-in");
    if (!row) {
      // Test sign-ins exist only on staging, behind TEST_SIGNIN_KEY, so the end-to-end check needs no invite.
      if (
        p.provider !== "test" &&
        this.env.INVITE_ONLY !== "false" &&
        !p.inviteAuthorized &&
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
      this.ctx.storage.transactionSync(() => {
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
        this.sql.exec(
          `INSERT INTO vaults (vault_id, user_id, hint, state, updated_at) VALUES (?, ?, ?, 'creating', ?)`,
          vaultId,
          userId,
          p.hint,
          now,
        );
      });
      row = this.findAccount(p.provider, p.subject)!;
    }
    if (row.user_state !== "active")
      throw new AppError("forbidden", "this account is being deleted");
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
    return { userId: row.user_id, vaultId: row.vault_id };
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
  ): Promise<number | null> {
    if (
      preferredShard !== null &&
      (!Number.isInteger(preferredShard) ||
        preferredShard < 0 ||
        preferredShard > 15)
    )
      throw new AppError("invalid", "invalid directory shard");
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
  }
  async bindIdentityHome(
    provider: string,
    subject: string,
    userId: string,
  ): Promise<void> {
    const home = this.sql.exec<{ shard: number | null; user_id: string | null }>(
      `SELECT shard,user_id FROM identity_homes WHERE provider=? AND subject=?`, provider, subject,
    ).toArray()[0];
    const shard = /^s(\d+):/.exec(userId);
    // Existing accounts may predate a placement row. Preserve their ability
    // to sign in, without treating a missing claim as proof of quiescence.
    if (!home) return;
    if ((shard ? Number(shard[1]) : null) !== home.shard ||
        (home.user_id !== null && home.user_id !== userId))
      throw new AppError("conflict", "account placement changed; retry sign-in");
    this.sql.exec(
      `UPDATE identity_homes SET user_id=? WHERE provider=? AND subject=? AND (user_id IS NULL OR user_id=?)`,
      userId,
      provider,
      subject,
      userId,
    );
  }
  async deletionProbe(userId: string, vaultId: string): Promise<number> {
    let count = 0;
    for (const table of [
      "users",
      "identities",
      "vaults",
      "billing_accounts",
      "vault_replacements",
      "retired_vaults",
      "identity_homes",
    ]) {
      count += this.sql
        .exec<{ n: number }>(
          `SELECT COUNT(*) AS n FROM ${table} WHERE user_id=?`,
          userId,
        )
        .one().n;
    }
    count += this.sql
      .exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM billing_events WHERE user_id=?`,
        userId,
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
    const home = this.sql.exec<{ shard: number | null; user_id: string | null }>(
      `SELECT shard,user_id FROM identity_homes WHERE provider=? AND subject=?`, provider, subject,
    ).toArray()[0];
    if (!home) return;
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
    this.requireInitializationSettled(targetId);
    await revokeOAuthUserGrants(this.env, operation.user_id);
    this.requireInitializationSettled(targetId);
    await this.env.VAULT.get(
      this.env.VAULT.idFromString(targetId),
    ).activateImport(operationId, operation.user_id);
    this.ctx.storage.transactionSync(() => {
      this.requireInitializationSettled(targetId);
      const source = this.sql
        .exec(
          `SELECT vault_id FROM vaults WHERE vault_id=? AND state='active'`,
          sourceId,
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
    });
    await this.scheduleAt(Date.now());
  }

  /** Marks the account for deletion; alarm() does the work and retries until it is done. */
  async deleteAccount(userId: string, expectedVaultId: string): Promise<void> {
    if (typeof expectedVaultId !== "string" || !expectedVaultId)
      throw new AppError("conflict", "the account vault has changed");
    const now = Date.now();
    // Keep the deletion state and its first alarm in the same SQLite-backed
    // storage transaction. If scheduling fails, the account remains active
    // and the caller can retry with the same session.
    const active = await this.ctx.storage.transaction(async () => {
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
      this.sql.exec(
        `UPDATE users SET state = 'deleting' WHERE user_id = ?`,
        userId,
      );
      this.sql.exec(
        `INSERT OR IGNORE INTO retired_vaults (vault_id,user_id) SELECT target_id,user_id FROM vault_replacements WHERE user_id=? AND state='preparing'`,
        userId,
      );
      this.sql.exec(
        `UPDATE vaults SET state = 'deleting', updated_at = ? WHERE user_id = ? AND state IN ('creating', 'active')`,
        now,
        userId,
      );
      const existing = await this.ctx.storage.getAlarm();
      if (existing === null || existing > now + RETRY_MS)
        await this.ctx.storage.setAlarm(now + RETRY_MS);
      return active;
    });
    // Creating vaults cannot have issued a session. Active or already deleting
    // vaults may have copied cookies; the durable alarm retries failed RPCs.
    for (const v of active)
      await this.env.VAULT.get(this.env.VAULT.idFromString(v.vault_id)).quiesce();
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

  /**
   * Erases deleting vaults: close the vault, stop its runs, delete its files, destroy it. After
   * SWEEP_DELAY_MS the files are swept once more, for any upload that raced the deletion, and then
   * the Directory rows go. Each vault is handled on its own, so one failure never blocks the others.
   */
  async alarm(): Promise<void> {
    // An external call can remain unresolved. Keep a durable retry before any
    // such call; a final harmless idle alarm is allowed to consume itself.
    if (
      this.billing.pending() ||
      this.vaultsIn("deleting").length > 0 ||
      this.vaultsIn("swept").length > 0 ||
      this.sql.exec(`SELECT vault_id FROM retired_vaults LIMIT 1`).toArray().length > 0
    ) await this.scheduleAt(Date.now() + RETRY_MS);
    try {
      await this.billing.reconcile();
    } catch {
      console.error("billing reconciliation pending", {
        code: "billing_unavailable",
      });
    }
    for (const v of this.vaultsIn("deleting")) {
      try {
        await this.erase(v.vault_id);
      } catch (e) {
        console.error("deletion step failed", {
          vaultId: v.vault_id,
          error: e instanceof Error ? e.name : "unknown",
        });
      }
    }
    for (const retired of this.sql
      .exec<{ vault_id: string; state: string; swept_at: number | null }>(
        `SELECT * FROM retired_vaults`,
      )
      .toArray()) {
      try {
        if (retired.state === "deleting") {
          const stub = this.env.VAULT.get(
            this.env.VAULT.idFromString(retired.vault_id),
          );
          // Revocation can proceed even while an old init acknowledgement is
          // unresolved. Destruction must still wait for that durable fence.
          await stub.quiesce();
          this.requireInitializationSettled(retired.vault_id);
          const runs = await stub.close();
          await stopVaultRuns(this.env, runs);
          await deletePrefix(this.env.FILES, vaultPrefix(retired.vault_id));
          await stub.destroy();
          this.sql.exec(
            `UPDATE retired_vaults SET state='swept',swept_at=? WHERE vault_id=?`,
            Date.now(),
            retired.vault_id,
          );
        } else if ((retired.swept_at ?? 0) <= Date.now() - this.sweepDelay()) {
          await deletePrefix(this.env.FILES, vaultPrefix(retired.vault_id));
          this.sql.exec(
            `DELETE FROM retired_vaults WHERE vault_id=?`,
            retired.vault_id,
          );
        }
      } catch {
        console.error("retirement pending", { vaultId: retired.vault_id });
      }
    }
    const due = Date.now() - this.sweepDelay();
    for (const v of this.vaultsIn("swept")) {
      if (
        (v.swept_at ?? 0) > due ||
        this.sql
          .exec(
            `SELECT vault_id FROM retired_vaults WHERE user_id=?`,
            v.user_id,
          )
          .toArray().length
      )
        continue;
      try {
        const shard = /^s(\d+):/.exec(v.user_id);
        if (shard) {
          for (const identity of this.sql
            .exec<{ provider: string; subject: string }>(
              `SELECT provider,subject FROM identities WHERE user_id=?`,
              v.user_id,
            )
            .toArray())
            await directory(this.env).forgetIdentityHome(
              identity.provider,
              identity.subject,
              Number(shard[1]),
              v.user_id,
            );
        }
        await directory(this.env).removeInvite(v.email);
        if (v.stripe_customer)
          await cleanupBillingCustomer(this.env, v.stripe_customer, fetch, parseCheckoutIds(v.stripe_checkout_sessions));
        else if (parseCheckoutIds(v.stripe_checkout_sessions).length)
          throw new AppError("unavailable", "checkout customer requires operator review");
        await revokeOAuthUserGrants(this.env, v.user_id);
        await deletePrefix(this.env.FILES, vaultPrefix(v.vault_id));
        this.ctx.storage.transactionSync(() => {
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
        });
      } catch (e) {
        console.error("final sweep failed", {
          vaultId: v.vault_id,
          error: e instanceof Error ? e.name : "unknown",
        });
      }
    }
    await this.scheduleNext();
  }

  private async erase(vaultId: string): Promise<void> {
    const stub = this.env.VAULT.get(this.env.VAULT.idFromString(vaultId));
    await stub.quiesce();
    this.requireInitializationSettled(vaultId);
    const runs = await stub.close();
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

  private sweepDelay(): number {
    const n = Number(this.env.SWEEP_DELAY_MS);
    return Number.isFinite(n) && n >= 0 ? n : 3_600_000;
  }

  private async scheduleNext(): Promise<void> {
    if (
      this.sql.exec(`SELECT vault_id FROM retired_vaults LIMIT 1`).toArray()
        .length
    )
      return this.scheduleAt(Date.now() + RETRY_MS);
    if (this.billing.pending()) return this.scheduleAt(Date.now() + RETRY_MS);
    if (this.vaultsIn("deleting").length > 0)
      return this.scheduleAt(Date.now() + RETRY_MS);
    const swept = this.vaultsIn("swept").map(
      (v) => (v.swept_at ?? 0) + this.sweepDelay(),
    );
    if (swept.length > 0) return this.scheduleAt(Math.min(...swept));
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
      if (!isMissingWorkflowInstance(error)) throw error;
    }
  }
}
