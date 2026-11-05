import { DurableObject } from "cloudflare:workers";
import { AppError } from "../shared/errors";
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
    void ctx.blockConcurrencyWhile(async () => migrateDirectory(this.ctx.storage.sql));
  }

  private get sql(): SqlStorage {
    return this.ctx.storage.sql;
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
      if (p.provider !== "test" && this.env.INVITE_ONLY !== "false" && !this.isInvited(email)) {
        throw new AppError("forbidden", "this email has not been invited to the beta yet");
      }
      const vaultId = this.env.VAULT.newUniqueId().toString();
      const userId = crypto.randomUUID();
      const now = Date.now();
      this.ctx.storage.transactionSync(() => {
        this.sql.exec(`INSERT INTO users (user_id, email, state, created_at) VALUES (?, ?, 'active', ?)`, userId, email, now);
        this.sql.exec(`INSERT INTO identities (provider, subject, user_id) VALUES (?, ?, ?)`, p.provider, p.subject, userId);
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
    if (row.user_state !== "active") throw new AppError("forbidden", "this account is being deleted");
    if (row.vault_state === "creating") {
      const id = this.env.VAULT.idFromString(row.vault_id);
      // Only the first get() of an object honours a location hint, so the vault is placed near the user now.
      await this.env.VAULT.get(id, { locationHint: row.hint as DurableObjectLocationHint }).init(row.user_id);
      this.sql.exec(`UPDATE vaults SET state = 'active', updated_at = ? WHERE vault_id = ? AND state = 'creating'`, Date.now(), row.vault_id);
    }
    return { userId: row.user_id, vaultId: row.vault_id };
  }

  /** Marks the account for deletion; alarm() does the work and retries until it is done. */
  async deleteAccount(userId: string): Promise<void> {
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(`UPDATE users SET state = 'deleting' WHERE user_id = ?`, userId);
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
        `SELECT v.vault_id, v.user_id, u.email, v.hint, v.state, v.swept_at, v.updated_at
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
    this.sql.exec(`INSERT OR IGNORE INTO invites (email, created_at) VALUES (?, ?)`, email.trim().toLowerCase(), Date.now());
  }

  async removeInvite(email: string): Promise<void> {
    this.sql.exec(`DELETE FROM invites WHERE email = ?`, email.trim().toLowerCase());
  }

  async listInvites(): Promise<{ email: string; createdAt: number }[]> {
    return this.sql
      .exec<{ email: string; created_at: number }>(`SELECT email, created_at FROM invites ORDER BY email`)
      .toArray()
      .map((r) => ({ email: r.email, createdAt: r.created_at }));
  }

  /**
   * Erases deleting vaults: close the vault, stop its runs, delete its files, destroy it. After
   * SWEEP_DELAY_MS the files are swept once more, for any upload that raced the deletion, and then
   * the Directory rows go. Each vault is handled on its own, so one failure never blocks the others.
   */
  async alarm(): Promise<void> {
    for (const v of this.vaultsIn("deleting")) {
      try {
        await this.erase(v.vault_id);
      } catch (e) {
        console.error("deletion step failed", { vaultId: v.vault_id, error: e instanceof Error ? e.name : "unknown" });
      }
    }
    const due = Date.now() - this.sweepDelay();
    for (const v of this.vaultsIn("swept")) {
      if ((v.swept_at ?? 0) > due) continue;
      try {
        await deletePrefix(this.env.FILES, vaultPrefix(v.vault_id));
        this.ctx.storage.transactionSync(() => {
          this.sql.exec(`DELETE FROM identities WHERE user_id = ?`, v.user_id);
          this.sql.exec(`DELETE FROM vaults WHERE vault_id = ?`, v.vault_id);
          this.sql.exec(`DELETE FROM users WHERE user_id = ?`, v.user_id);
        });
      } catch (e) {
        console.error("final sweep failed", { vaultId: v.vault_id, error: e instanceof Error ? e.name : "unknown" });
      }
    }
    await this.scheduleNext();
  }

  private async erase(vaultId: string): Promise<void> {
    const stub = this.env.VAULT.get(this.env.VAULT.idFromString(vaultId));
    const runs = await stub.close();
    await stopRuns(this.env.DISTILL, runs.distill);
    await stopRuns(this.env.TAILOR, runs.tailor);
    await deletePrefix(this.env.FILES, vaultPrefix(vaultId));
    // The vault goes last, so a retry after any failure above can still ask it which runs to stop.
    await stub.destroy();
    this.sql.exec(`UPDATE vaults SET state = 'swept', swept_at = ?, updated_at = ? WHERE vault_id = ?`, Date.now(), Date.now(), vaultId);
  }

  private sweepDelay(): number {
    const n = Number(this.env.SWEEP_DELAY_MS);
    return Number.isFinite(n) && n >= 0 ? n : 3_600_000;
  }

  private async scheduleNext(): Promise<void> {
    if (this.vaultsIn("deleting").length > 0) return this.scheduleAt(Date.now() + RETRY_MS);
    const swept = this.vaultsIn("swept").map((v) => (v.swept_at ?? 0) + this.sweepDelay());
    if (swept.length > 0) return this.scheduleAt(Math.min(...swept));
  }

  private async scheduleAt(when: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > when) await this.ctx.storage.setAlarm(when);
  }

  private vaultsIn(state: "deleting" | "swept"): VaultDbRow[] {
    return this.sql
      .exec<VaultDbRow>(
        `SELECT v.vault_id, v.user_id, u.email, v.hint, v.state, v.swept_at, v.updated_at
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
    return this.sql.exec(`SELECT email FROM invites WHERE email = ?`, email).toArray().length > 0;
  }
}

/** Terminates runs, skipping any that are missing or already finished. */
async function stopRuns(workflow: Workflow, ids: string[]): Promise<void> {
  for (const id of ids) {
    try {
      const instance = await workflow.get(id);
      const { status } = await instance.status();
      if (status === "complete" || status === "errored" || status === "terminated") continue;
      await instance.terminate();
    } catch {
      // Missing or already finished: nothing to stop.
    }
  }
}
