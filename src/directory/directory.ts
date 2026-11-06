import { revokeOAuthUserGrants } from "../worker/mcp";
import { BillingStore } from "./billing";
import { cleanupBillingCustomer, type BillingEvent } from "../worker/billing";
import { directory } from "../shared/stubs";
import { requireMaintenanceFence, shardedUserId } from "../shared/operations";
import { DurableObject } from "cloudflare:workers";
import { AppError, errorCode } from "../shared/errors";
import { deletePrefix, vaultPrefix } from "../shared/r2";
import type { SignInInput, VaultRow } from "../shared/types";
import { migrateDirectory } from "./schema";

/** How soon a failed deletion is retried. */
const RETRY_MS = 60_000;

type AccountRow = {
  user_id: string;
  user_state: string;
  vault_id: string;
  vault_state: string;
  hint: string;
};

type VaultDbRow = {
  stripe_customer: string | null;
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
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () =>
      migrateDirectory(this.ctx.storage.sql),
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
      const id = this.env.VAULT.idFromString(row.vault_id);
      // Only the first get() of an object honours a location hint, so the vault is placed near the user now.
      await this.env.VAULT.get(id, {
        locationHint: row.hint as DurableObjectLocationHint,
      }).init(row.user_id);
      this.sql.exec(
        `UPDATE vaults SET state = 'active', updated_at = ? WHERE vault_id = ? AND state = 'creating'`,
        Date.now(),
        row.vault_id,
      );
    }
    return { userId: row.user_id, vaultId: row.vault_id };
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
    this.sql.exec(
      `UPDATE identity_homes SET user_id=? WHERE provider=? AND subject=?`,
      userId,
      provider,
      subject,
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
  ): Promise<void> {
    this.sql.exec(
      `DELETE FROM identity_homes WHERE provider=? AND subject=? AND shard IS ?`,
      provider,
      subject,
      shard,
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
      .exec<{ source_id: string; target_id: string; user_id: string }>(
        `SELECT * FROM vault_replacements WHERE operation_id=?`,
        operationId,
      )
      .toArray()[0];
    if (prior) {
      if (prior.source_id !== sourceId)
        throw new AppError("conflict", "operation belongs to another vault");
      await this.env.VAULT.get(
        this.env.VAULT.idFromString(prior.target_id),
      ).init(prior.user_id);
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
    await this.env.VAULT.get(this.env.VAULT.idFromString(targetId)).init(
      source.user_id,
    );
    return { targetVaultId: targetId };
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
    await revokeOAuthUserGrants(this.env, operation.user_id);
    await this.env.VAULT.get(
      this.env.VAULT.idFromString(targetId),
    ).activateImport(operationId, operation.user_id);
    this.ctx.storage.transactionSync(() => {
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
  async deleteAccount(userId: string): Promise<void> {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
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
    });
    await this.scheduleAt(now);
  }

  async listVaults(p: { after?: string; limit: number }): Promise<VaultRow[]> {
    const limit = Math.max(1, Math.min(200, Math.floor(p.limit)));
    return this.sql
      .exec<VaultDbRow>(
        `SELECT v.vault_id, v.user_id, u.email, v.hint, v.state, v.swept_at, v.updated_at, v.stripe_customer
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
          const runs = await stub.close();
          await stopRuns(this.env.DISTILL, runs.distill);
          await stopRuns(this.env.TAILOR, runs.tailor);
          for (const run of runs.other ?? [])
            await stopRuns(
              run.kind === "reembed" ? this.env.REEMBED : this.env.DOCUMENTS,
              [run.id],
            );
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
            );
        }
        await directory(this.env).removeInvite(v.email);
        if (v.stripe_customer)
          await cleanupBillingCustomer(this.env, v.stripe_customer);
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
    const runs = await stub.close();
    const customer = await stub.billingCustomerForDeletion();
    if (customer) {
      this.sql.exec(
        `UPDATE vaults SET stripe_customer=? WHERE vault_id=?`,
        customer,
        vaultId,
      );
      await cleanupBillingCustomer(this.env, customer);
    }
    await stopRuns(this.env.DISTILL, runs.distill);
    await stopRuns(this.env.TAILOR, runs.tailor);
    // Every added workflow must join erasure. A missing binding fails closed so the
    // alarm retries instead of silently destroying the only inventory of its runs.
    const bindings: Record<string, string> = {
      distill: "DISTILL",
      tailor: "TAILOR",
      refine: "DOCUMENTS",
      letter: "DOCUMENTS",
      prep: "DOCUMENTS",
      questions: "DOCUMENTS",
      reembed: "REEMBED",
    };
    for (const run of (
      runs as typeof runs & { other?: { kind: string; id: string }[] }
    ).other ?? []) {
      const binding = bindings[run.kind];
      const workflow = binding
        ? (this.env as unknown as Record<string, Workflow | undefined>)[binding]
        : undefined;
      if (!workflow)
        throw new AppError(
          "unavailable",
          "a workflow required for deletion is not configured",
        );
      await stopRuns(workflow, [run.id]);
    }
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
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > when)
      await this.ctx.storage.setAlarm(when);
  }

  private vaultsIn(state: "deleting" | "swept"): VaultDbRow[] {
    return this.sql
      .exec<VaultDbRow>(
        `SELECT v.vault_id, v.user_id, u.email, v.hint, v.state, v.swept_at, v.updated_at, v.stripe_customer
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
      if (!missingWorkflow(error)) throw error;
    }
  }
}

function missingWorkflow(error: unknown): boolean {
  if (errorCode(error) === "not_found") return true;
  if (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === 404
  )
    return true;
  if (error instanceof Error && error.message === "instance.not_found")
    return true;
  // Workflows bindings may expose absence only as a platform error message.
  // Deliberately do not classify generic errors, timeouts or permission failures.
  return (
    error instanceof Error &&
    /^(?:Error: )?(?:Workflow )?instance(?: with (?:ID|id))? [^\n]{1,120} (?:not found|does not exist)\.?$/i.test(
      error.message,
    )
  );
}
