import { AppError } from "../shared/errors";

// Installed in every Directory, but inactive until a shard explicitly seals.
// The epoch marker remains required after closing, fencing old in-flight writes.
export const INVITE_INVENTORY_MIGRATIONS = [
  `CREATE TABLE shard_invite_inventory (
    operation_id TEXT PRIMARY KEY, email TEXT, excluded_user_id TEXT,
    seal_epoch INTEGER NOT NULL, close_epoch INTEGER, other_users INTEGER,
    state TEXT NOT NULL CHECK(state IN ('active','closed'))
  )`,
  `CREATE UNIQUE INDEX shard_invite_one_active ON shard_invite_inventory((1)) WHERE state='active'`,
  `CREATE TRIGGER shard_invite_seal_insert BEFORE INSERT ON users
   WHEN EXISTS(SELECT 1 FROM shard_invite_inventory WHERE state='active')
   BEGIN SELECT RAISE(ABORT, 'invite_inventory_sealed'); END`,
  `CREATE TRIGGER shard_invite_seal_update BEFORE UPDATE ON users
   WHEN EXISTS(SELECT 1 FROM shard_invite_inventory WHERE state='active')
   BEGIN SELECT RAISE(ABORT, 'invite_inventory_sealed'); END`,
  `CREATE TRIGGER shard_invite_seal_delete BEFORE DELETE ON users
   WHEN EXISTS(SELECT 1 FROM shard_invite_inventory WHERE state='active')
   BEGIN SELECT RAISE(ABORT, 'invite_inventory_sealed'); END`,
  `CREATE TRIGGER shard_invite_epoch_insert BEFORE INSERT ON users
   WHEN EXISTS(SELECT 1 FROM meta WHERE key='shard_invite_epoch_guard' AND value='1')
    AND NOT EXISTS(SELECT 1 FROM shard_auth_marker WHERE slot=1 AND epoch >= CAST((SELECT value FROM meta WHERE key='shard_auth_floor') AS INTEGER))
   BEGIN SELECT RAISE(ABORT, 'invite_inventory_epoch_required'); END`,
];

type SealRow = {
  email: string | null; excluded_user_id: string | null; seal_epoch: number;
  close_epoch: number | null; other_users: number | null; state: string;
};
export type ShardInviteInventory = { state: "active"; otherUsers: number } | { state: "closed" };

/**
 * Shard-side primitive only. Its count does not authorize invite removal:
 * the coordinator must retain its global creation barrier, collect receipts
 * from every shard and global users, then close every shard at a later epoch.
 */
export class InviteInventory {
  constructor(
    private readonly sql: SqlStorage,
    private readonly transaction: <T>(fn: () => T) => T,
    private readonly floor: () => number,
    private readonly mayExclude: (userId: string) => boolean,
  ) {}

  private identity(operation: string, epoch: number): void {
    if (typeof operation !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operation) ||
        !Number.isSafeInteger(epoch) || epoch <= 0)
      throw new AppError("invalid", "invalid invitation inventory");
  }

  private row(operation: string): SealRow | undefined {
    return this.sql.exec<SealRow>(`SELECT email,excluded_user_id,seal_epoch,close_epoch,other_users,state FROM shard_invite_inventory WHERE operation_id=?`, operation).toArray()[0];
  }

  private setFloor(epoch: number): void {
    this.sql.exec(`UPDATE meta SET value=? WHERE key='shard_auth_floor'`, String(Math.max(this.floor(), epoch)));
    this.sql.exec(`INSERT INTO meta(key,value) VALUES ('shard_invite_epoch_guard','1') ON CONFLICT(key) DO UPDATE SET value='1'`);
  }

  seal(operation: string, rawEmail: string, excludedUserId: string, epoch: number): ShardInviteInventory {
    this.identity(operation, epoch);
    if (typeof rawEmail !== "string" || !rawEmail.trim() || rawEmail.length > 320 ||
        typeof excludedUserId !== "string" || !excludedUserId || excludedUserId.length > 100)
      throw new AppError("invalid", "invalid invitation inventory");
    const email = rawEmail.trim().toLowerCase();
    return this.transaction(() => {
      const old = this.row(operation);
      if (old) {
        if (old.seal_epoch !== epoch) throw new AppError("conflict", "invitation inventory changed");
        if (old.state === "closed") {
          if (old.email !== null || old.excluded_user_id !== null || old.other_users !== null || !Number.isSafeInteger(old.close_epoch) || old.close_epoch! <= epoch)
            throw new AppError("unavailable", "invitation inventory requires review");
          return { state: "closed" };
        }
        if (old.state !== "active" || old.email !== email || old.excluded_user_id !== excludedUserId || old.close_epoch !== null ||
            !Number.isSafeInteger(old.other_users) || old.other_users! < 0)
          throw new AppError("conflict", "invitation inventory changed");
        return { state: "active", otherUsers: old.other_users! };
      }
      if (this.sql.exec(`SELECT operation_id FROM shard_invite_inventory WHERE state='active'`).toArray().length)
        throw new AppError("unavailable", "invitation inventory is busy");
      // A delayed first seal must not install a new inventory from an epoch
      // that this shard has already superseded, even if its close was lost.
      if (epoch < this.floor())
        throw new AppError("conflict", "invitation inventory is stale");
      this.setFloor(epoch);
      // Insert the seal before observing users, in the same transaction.
      this.sql.exec(`INSERT INTO shard_invite_inventory(operation_id,email,excluded_user_id,seal_epoch,state) VALUES (?,?,?,?,'active')`, operation, email, excludedUserId, epoch);
      let seen = 0, otherUsers = 0;
      for (const user of this.sql.exec<{ user_id: SqlStorageValue; email: SqlStorageValue; state: SqlStorageValue }>(`SELECT user_id,email,state FROM users ORDER BY rowid LIMIT 10001`)) {
        if (++seen > 10_000 || typeof user.user_id !== "string" || !user.user_id || typeof user.email !== "string" ||
            !user.email.trim() || user.email.length > 320 ||
            (user.state !== "active" && user.state !== "deleting"))
          throw new AppError("unavailable", "invitation inventory requires review");
        // Only the account's actual home can exclude it. A duplicate or
        // misplaced ID on another shard is an additional user, not proof of
        // exclusivity.
        // Deleting accounts have no reactivation path in the current code.
        // Counting them as active can orphan a grant when same-email account
        // deletions overlap. Restores and older runtimes must be drained or
        // independently fenced before relying on this assumption.
        if (user.state === "active" && (user.user_id !== excludedUserId || !this.mayExclude(excludedUserId)) && user.email.trim().toLowerCase() === email) otherUsers++;
      }
      this.sql.exec(`UPDATE shard_invite_inventory SET other_users=? WHERE operation_id=?`, otherUsers, operation);
      return { state: "active", otherUsers };
    });
  }

  close(operation: string, sealEpoch: number, closeEpoch: number): void {
    this.identity(operation, sealEpoch);
    if (!Number.isSafeInteger(closeEpoch) || closeEpoch <= sealEpoch)
      throw new AppError("invalid", "invalid invitation inventory close");
    this.transaction(() => {
      const old = this.row(operation);
      if (old && old.seal_epoch !== sealEpoch) throw new AppError("conflict", "invitation inventory changed");
      if (old?.state === "closed") {
        if (old.close_epoch !== closeEpoch || old.email !== null || old.excluded_user_id !== null || old.other_users !== null)
          throw new AppError("conflict", "invitation inventory changed");
        return;
      }
      if (old && (old.state !== "active" || old.close_epoch !== null || old.email === null || old.excluded_user_id === null || !Number.isSafeInteger(old.other_users)))
        throw new AppError("unavailable", "invitation inventory requires review");
      this.setFloor(closeEpoch);
      // Even a close received before seal must tombstone the operation: a
      // delayed first seal must not resurrect it or count as an observation.
      this.sql.exec(`INSERT INTO shard_invite_inventory(operation_id,seal_epoch,close_epoch,state) VALUES (?,?,?,'closed')
        ON CONFLICT(operation_id) DO UPDATE SET email=NULL,excluded_user_id=NULL,other_users=NULL,close_epoch=excluded.close_epoch,state='closed'`, operation, sealEpoch, closeEpoch);
    });
  }
}
