import { AppError } from "../shared/errors";

// A single global barrier serializes cross-shard inventories. The guards apply
// on every Directory but are inert unless the coordinator installs a barrier.
export const INVITE_COORDINATOR_MIGRATIONS = [
  `CREATE TABLE invite_inventory_barrier (
    slot INTEGER PRIMARY KEY CHECK(slot=1), operation_id TEXT NOT NULL UNIQUE, attempt_id TEXT NOT NULL UNIQUE,
    user_id TEXT NOT NULL, vault_id TEXT NOT NULL, email TEXT NOT NULL,
    final_generation TEXT NOT NULL, seal_epoch INTEGER NOT NULL,
    close_epoch INTEGER, phase TEXT NOT NULL CHECK(phase IN ('sealing','closing')),
    outcome TEXT CHECK(outcome IN ('decided','retry'))
  )`,
  `CREATE TABLE invite_inventory_receipts (
    operation_id TEXT NOT NULL, shard INTEGER NOT NULL CHECK(shard BETWEEN 0 AND 15),
    other_users INTEGER, closed INTEGER NOT NULL DEFAULT 0 CHECK(closed IN (0,1)),
    PRIMARY KEY(operation_id,shard)
  )`,
  ...["users", "identity_homes"].flatMap((table) => ["INSERT", "UPDATE", "DELETE"].map((action) =>
    `CREATE TRIGGER inventory_barrier_${table}_${action.toLowerCase()} BEFORE ${action} ON ${table}
     WHEN EXISTS(SELECT 1 FROM invite_inventory_barrier WHERE slot=1)
     BEGIN SELECT RAISE(ABORT, 'invite_inventory_barrier_active'); END`,
  )),
  ...["users", "identity_homes"].map((table) =>
    `CREATE TRIGGER inventory_epoch_${table}_insert BEFORE INSERT ON ${table}
     WHEN EXISTS(SELECT 1 FROM meta WHERE key='invite_inventory_epoch_guard' AND value='1')
     AND NOT EXISTS(SELECT 1 FROM global_auth_marker WHERE slot=1 AND epoch=CAST((SELECT value FROM meta WHERE key='global_auth_epoch') AS INTEGER))
     BEGIN SELECT RAISE(ABORT, 'invite_inventory_epoch_required'); END`,
  ),
  `CREATE TRIGGER inventory_epoch_identity_homes_bind BEFORE UPDATE OF user_id ON identity_homes
   WHEN EXISTS(SELECT 1 FROM meta WHERE key='invite_inventory_epoch_guard' AND value='1')
   AND NOT EXISTS(SELECT 1 FROM global_auth_marker WHERE slot=1 AND epoch=CAST((SELECT value FROM meta WHERE key='global_auth_epoch') AS INTEGER))
   BEGIN SELECT RAISE(ABORT, 'invite_inventory_epoch_required'); END`,
  // Old finalizers cannot authorize deletion after this migration. The new
  // code installs this marker only inside the authorizing transaction.
  `CREATE TABLE invite_delete_authorizations_v3 (email TEXT PRIMARY KEY)`,
  `CREATE TRIGGER guard_invite_delete_authorization_v3 BEFORE INSERT ON invite_delete_authorizations_v2
   WHEN NOT EXISTS(SELECT 1 FROM invite_delete_authorizations_v3 WHERE email=NEW.email)
   BEGIN SELECT RAISE(ABORT, 'invite_delete_authorization_v3_required'); END`,
];

export type InventoryIdentity = { operationId: string; userId: string; vaultId: string; email: string; finalGeneration: string };
type Barrier = {
  operation_id: string; attempt_id: string; user_id: string; vault_id: string; email: string; final_generation: string;
  seal_epoch: number; close_epoch: number | null; phase: "sealing" | "closing"; outcome: "decided" | "retry" | null;
};
type SealResult = { state: "active"; otherUsers: number } | { state: "closed" };
type Deps = {
  sql: SqlStorage;
  transaction: <T>(f: () => T) => T;
  storage: DurableObjectStorage;
  epoch: () => number;
  seal: (shard: number, b: InventoryIdentity, attempt: string, epoch: number) => Promise<SealResult>;
  close: (shard: number, operation: string, sealEpoch: number, closeEpoch: number) => Promise<void>;
  validate: (b: InventoryIdentity) => void;
  sealWaitMs?: number;
  // Called in the decision transaction only after every shard is sealed.
  decide: (b: InventoryIdentity, otherUsers: number) => void;
  // Called only after all close acknowledgements are committed.
  finish: (b: InventoryIdentity) => void;
};
const RETRY_MS = 60_000;

export class InviteCoordinator {
  constructor(private readonly d: Deps) {}
  private row(): Barrier | undefined {
    return this.d.sql.exec<Barrier>(`SELECT operation_id,attempt_id,user_id,vault_id,email,final_generation,seal_epoch,close_epoch,phase,outcome FROM invite_inventory_barrier WHERE slot=1`).toArray()[0];
  }
  active(): boolean { return !!this.row(); }
  private identity(row: Barrier): InventoryIdentity {
    return { operationId: row.operation_id, userId: row.user_id, vaultId: row.vault_id, email: row.email, finalGeneration: row.final_generation };
  }
  private same(row: Barrier, b: InventoryIdentity): boolean {
    return row.operation_id === b.operationId && row.user_id === b.userId && row.vault_id === b.vaultId && row.email === b.email && row.final_generation === b.finalGeneration;
  }
  private advanceEpoch(): number {
    const epoch = this.d.epoch();
    if (!Number.isSafeInteger(epoch) || epoch < 0 || epoch >= Number.MAX_SAFE_INTEGER)
      throw new AppError("unavailable", "invitation inventory requires review");
    this.d.sql.exec(`UPDATE meta SET value=? WHERE key='global_auth_epoch'`, String(epoch + 1));
    return epoch + 1;
  }
  /** The retry alarm and barrier commit atomically, before any shard RPC. */
  async begin(b: InventoryIdentity): Promise<void> {
    await this.d.storage.transaction(async () => {
      const existing = this.row();
      if (existing) {
        if (!this.same(existing, b)) throw new AppError("unavailable", "invitation inventory is busy");
      } else {
        this.d.validate(b);
        const epoch = this.advanceEpoch();
        this.d.sql.exec(`INSERT INTO meta(key,value) VALUES ('invite_inventory_epoch_guard','1') ON CONFLICT(key) DO UPDATE SET value='1'`);
        this.d.sql.exec(`INSERT INTO invite_inventory_barrier(slot,operation_id,attempt_id,user_id,vault_id,email,final_generation,seal_epoch,phase) VALUES (1,?,?,?,?,?,?,?,'sealing')`,
          b.operationId, crypto.randomUUID(), b.userId, b.vaultId, b.email, b.finalGeneration, epoch);
      }
      const now = Date.now() + RETRY_MS;
      const old = await this.d.storage.getAlarm();
      if (old === null || old > now) await this.d.storage.setAlarm(now);
    });
  }
  private startClose(operationId: string, attempt: string, outcome: "decided" | "retry"): void {
    const row = this.row();
    if (!row || row.operation_id !== operationId || row.attempt_id !== attempt || row.phase !== "sealing") return;
    const closeEpoch = this.advanceEpoch();
    this.d.sql.exec(`UPDATE invite_inventory_barrier SET phase='closing',outcome=?,close_epoch=? WHERE slot=1 AND operation_id=? AND phase='sealing'`, outcome, closeEpoch, operationId);
  }
  /** Recoverable after a crash or lost reply. Shards fence late seal calls by tombstone. */
  async resume(): Promise<void> {
    let row = this.row();
    if (!row) return;
    const b = this.identity(row);
    const attempt = row.attempt_id;
    if (row.phase === "sealing") {
      const sealEpoch = row.seal_epoch;
      const pending = Array.from({ length: 16 }, (_, shard) => shard).filter((shard) => !this.d.sql.exec(
        `SELECT shard FROM invite_inventory_receipts WHERE operation_id=? AND shard=? AND other_users IS NOT NULL`, attempt, shard,
      ).toArray().length);
      let wake!: () => void;
      const failed = new Promise<void>((resolve) => { wake = resolve; });
      const tasks = Promise.allSettled(pending.map(async (shard) => {
        try {
          const receipt = await this.d.seal(shard, b, attempt, sealEpoch);
          if (receipt.state !== "active" || !Number.isSafeInteger(receipt.otherUsers) || receipt.otherUsers < 0 || receipt.otherUsers > 10_000)
            throw new Error("invalid_inventory_receipt");
          this.d.transaction(() => {
            const current = this.row();
            if (!current || !this.same(current, b) || current.attempt_id !== attempt || current.phase !== "sealing" || current.seal_epoch !== sealEpoch) return;
            const old = this.d.sql.exec<{ other_users: number | null }>(`SELECT other_users FROM invite_inventory_receipts WHERE operation_id=? AND shard=?`, attempt, shard).toArray()[0];
            if (old && old.other_users !== receipt.otherUsers) throw new AppError("unavailable", "invitation inventory changed");
            this.d.sql.exec(`INSERT OR IGNORE INTO invite_inventory_receipts(operation_id,shard,other_users) VALUES (?,?,?)`, attempt, shard, receipt.otherUsers);
          });
        } catch {
          this.d.transaction(() => this.startClose(b.operationId, attempt, "retry"));
          wake();
        }
      }));
      // A timed-out seal is not assumed absent. Closing every shard creates a
      // durable tombstone before the barrier can be released, fencing a seal
      // that starts or returns later. All dispatched promises stay observed.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.d.sealWaitMs ?? 30_000);
      });
      const result = await Promise.race([tasks.then(() => "done" as const), failed.then(() => "failed" as const), timeout.then(() => "timeout" as const)]);
      if (timer !== undefined) clearTimeout(timer);
      if (result === "timeout") this.d.transaction(() => this.startClose(b.operationId, attempt, "retry"));
      try {
        this.d.transaction(() => {
          const current = this.row();
          if (!current || !this.same(current, b) || current.attempt_id !== attempt || current.phase !== "sealing") return;
          const receipts = this.d.sql.exec<{ shard: number; other_users: number }>(`SELECT shard,other_users FROM invite_inventory_receipts WHERE operation_id=? AND other_users IS NOT NULL ORDER BY shard`, attempt).toArray();
          if (receipts.length !== 16 || receipts.some((r, i) => r.shard !== i || !Number.isSafeInteger(r.other_users) || r.other_users < 0 || r.other_users > 10_000)) return;
          this.d.decide(b, receipts.reduce((sum, r) => sum + r.other_users, 0));
          this.startClose(b.operationId, attempt, "decided");
        });
      } catch {
        this.d.transaction(() => this.startClose(b.operationId, attempt, "retry"));
      }
    }
    row = this.row();
    if (!row || !this.same(row, b) || row.attempt_id !== attempt || row.phase !== "closing") return;
    const closeEpoch = row.close_epoch;
    if (!Number.isSafeInteger(closeEpoch) || closeEpoch! <= row.seal_epoch || !["decided", "retry"].includes(row.outcome ?? ""))
      throw new AppError("unavailable", "invitation inventory requires review");
    const sealEpoch = row.seal_epoch;
    const pending = Array.from({ length: 16 }, (_, shard) => shard).filter((shard) => !this.d.sql.exec(
      `SELECT shard FROM invite_inventory_receipts WHERE operation_id=? AND shard=? AND closed=1`, attempt, shard,
    ).toArray().length);
    const closes = Promise.allSettled(pending.map(async (shard) => {
      try {
        await this.d.close(shard, attempt, sealEpoch, closeEpoch!);
        this.d.transaction(() => {
          const current = this.row();
          if (!current || !this.same(current, b) || current.attempt_id !== attempt || current.phase !== "closing" || current.close_epoch !== closeEpoch) return;
          this.d.sql.exec(`INSERT INTO invite_inventory_receipts(operation_id,shard,closed) VALUES (?,?,1) ON CONFLICT(operation_id,shard) DO UPDATE SET closed=1`, attempt, shard);
        });
      } catch { /* prearmed alarm retries; an unknown reply is not an acknowledgement */ }
    }));
    // Keep the barrier if any acknowledgement remains unknown. A late reply
    // may record its own ACK only against this exact attempt and epoch.
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const closeTimeout = new Promise<void>((resolve) => { closeTimer = setTimeout(resolve, this.d.sealWaitMs ?? 30_000); });
    await Promise.race([closes, closeTimeout]);
    if (closeTimer !== undefined) clearTimeout(closeTimer);
    this.d.transaction(() => {
      const current = this.row();
      if (!current || !this.same(current, b) || current.attempt_id !== attempt || current.phase !== "closing" || current.close_epoch !== closeEpoch) return;
      const count = this.d.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM invite_inventory_receipts WHERE operation_id=? AND closed=1`, attempt).one().n;
      if (count !== 16) return;
      if (current.outcome === "decided") this.d.finish(b);
      this.d.sql.exec(`DELETE FROM invite_inventory_receipts WHERE operation_id=?`, attempt);
      this.d.sql.exec(`DELETE FROM invite_inventory_barrier WHERE slot=1 AND operation_id=?`, b.operationId);
    });
  }
}
