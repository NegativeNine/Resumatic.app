import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { directory } from "../../src/shared/stubs";
import type { Directory } from "../../src/directory/directory";

const shard = (n: number) => env.DIRECTORY.getByName(`directory-${n}`);
const email = () => `inventory-${crypto.randomUUID()}@example.test`;
const testInput = (address: string, n: number, epoch?: number) => ({ provider: "test" as const, subject: crypto.randomUUID(), email: address, hint: "enam" as const, homeShard: n, authEpoch: epoch });
const googleInput = (address: string, n: number, epoch: number) => ({ ...testInput(address, n, epoch), provider: "google" as const, inviteAuthorized: true });

const local = <T>(target: ReturnType<typeof shard>, fn: (instance: Directory) => Promise<T>) =>
  runInDurableObject(target, (instance) => fn(instance as Directory));

async function floor(target: ReturnType<typeof shard>) {
  // Force first activation, which installs the rollout floor.
  await target.existingIdentity("google", crypto.randomUUID());
  return runInDurableObject(target, (_instance, state) => Number(state.storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='shard_auth_floor'`).one().value));
}

describe("shard invitation inventory", () => {
  it("initializes a previously unused shard while a global inventory barrier is active", async () => {
    const global = directory(env), target = shard(10), op = crypto.randomUUID(), attempt = crypto.randomUUID();
    const first = (await global.googleAuthEpoch()) + 1, last = first + 1, address = email();
    // Do not touch the shard before the barrier: its constructor must fetch
    // the fixed historical rollout boundary while processing the first seal.
    await runInDurableObject(global, (_instance, state) => state.storage.transactionSync(() => {
      state.storage.sql.exec(`UPDATE meta SET value=? WHERE key='global_auth_epoch'`, String(first));
      state.storage.sql.exec(`INSERT INTO invite_inventory_barrier(slot,operation_id,attempt_id,user_id,vault_id,email,final_generation,seal_epoch,phase) VALUES (1,?,?,?,?,?,?,?,'sealing')`,
        op, attempt, crypto.randomUUID(), "synthetic-vault", address, crypto.randomUUID(), first);
    }));
    try {
      await expect(local(global, (instance) => instance.googleAuthEpoch())).rejects.toThrow(/temporarily unavailable/);
      expect(await global.googleShardRolloutEpoch()).toBeGreaterThan(0);
      expect(await target.sealInviteInventory(attempt, address, crypto.randomUUID(), first)).toEqual({ state: "active", otherUsers: 0 });
    } finally {
      await target.closeInviteInventory(attempt, first, last);
      await runInDurableObject(global, (_instance, state) => state.storage.transactionSync(() => {
        state.storage.sql.exec(`UPDATE meta SET value=? WHERE key='global_auth_epoch'`, String(last));
        state.storage.sql.exec(`DELETE FROM invite_inventory_barrier WHERE operation_id=?`, op);
      }));
    }
  });

  it("holds an immutable receipt, blocks mutations and requires a fresh epoch after release", async () => {
    const n = 12, target = shard(n), address = email(), op = crypto.randomUUID();
    const base = await floor(target);
    const other = await target.signIn(testInput(address, n));
    const excluded = await target.signIn(testInput(address, n));
    const first = base + 10, last = first + 1;
    expect(await target.sealInviteInventory(op, address, excluded.userId, first)).toEqual({ state: "active", otherUsers: 1 });
    expect(await target.sealInviteInventory(op, address.toUpperCase(), excluded.userId, first)).toEqual({ state: "active", otherUsers: 1 });
    await expect(local(target, (instance) => instance.sealInviteInventory(op, address, other.userId, first))).rejects.toThrow(/changed/);
    await expect(local(target, (instance) => instance.signIn(googleInput(email(), n, first)))).rejects.toThrow(/invite_inventory_sealed/);
    await runInDurableObject(target, (_instance, state) => {
      expect(() => state.storage.sql.exec(`UPDATE users SET email=? WHERE user_id=?`, email(), other.userId)).toThrow(/invite_inventory_sealed/);
      expect(() => state.storage.sql.exec(`DELETE FROM users WHERE user_id=?`, other.userId)).toThrow(/invite_inventory_sealed/);
    });
    await expect(local(target, (instance) => instance.closeInviteInventory(op, first, first))).rejects.toThrow(/invalid/);
    await target.closeInviteInventory(op, first, last);
    await target.closeInviteInventory(op, first, last);
    expect(await target.sealInviteInventory(op, address, excluded.userId, first)).toEqual({ state: "closed" });
    await expect(local(target, (instance) => instance.signIn(googleInput(email(), n, first)))).rejects.toThrow(/stale/);
    expect((await target.signIn(googleInput(email(), n, last))).userId).toBeTruthy();
    // Test identities need the same freshly issued epoch after the first seal.
    await expect(local(target, (instance) => instance.signIn(testInput(email(), n)))).rejects.toThrow(/stale/);
    expect((await target.signIn(testInput(email(), n, last))).userId).toBeTruthy();
    await runInDurableObject(target, (_instance, state) => {
      const row = state.storage.sql.exec<{ email: string | null; excluded_user_id: string | null; other_users: number | null }>(`SELECT email,excluded_user_id,other_users FROM shard_invite_inventory WHERE operation_id=?`, op).one();
      expect(row).toEqual({ email: null, excluded_user_id: null, other_users: null });
      expect(() => state.storage.sql.exec(`INSERT INTO users(user_id,email,state,created_at) VALUES (?,?,?,?)`, crypto.randomUUID(), email(), "active", Date.now())).toThrow(/epoch_required/);
    });
  });

  it("tombstones close-before-seal and rejects delayed epochs and conflicting closes", async () => {
    const target = shard(13), op = crypto.randomUUID(), address = email();
    const base = await floor(target), first = base + 10, last = first + 1;
    await target.closeInviteInventory(op, first, last);
    expect(await target.sealInviteInventory(op, address, "old-user", first)).toEqual({ state: "closed" });
    await expect(local(target, (instance) => instance.sealInviteInventory(op, address, "old-user", first + 1))).rejects.toThrow(/changed/);
    await expect(local(target, (instance) => instance.closeInviteInventory(op, first, last + 1))).rejects.toThrow(/changed/);
    await expect(local(target, (instance) => instance.sealInviteInventory(crypto.randomUUID(), address, "old-user", first))).rejects.toThrow(/stale/);
    await expect(local(target, (instance) => instance.signIn(googleInput(email(), 13, first)))).rejects.toThrow(/stale/);
    expect((await target.signIn(googleInput(email(), 13, last))).userId).toBeTruthy();
    await expect(local(directory(env), (instance) => instance.sealInviteInventory(op, address, "old-user", first))).rejects.toThrow(/requires a shard/);
  });

  it("serializes seals and rolls back malformed inventories", async () => {
    const target = shard(14), address = email(), op = crypto.randomUUID(), competing = crypto.randomUUID();
    const base = await floor(target), first = base + 10, last = first + 1;
    await target.sealInviteInventory(op, address, "excluded", first);
    await expect(local(target, (instance) => instance.sealInviteInventory(competing, address, "excluded", first))).rejects.toThrow(/busy/);
    await target.closeInviteInventory(op, first, last);
    await runInDurableObject(target, (_instance, state) => {
      state.storage.sql.exec(`INSERT INTO shard_auth_marker(slot,epoch) VALUES (1,?)`, last);
      state.storage.sql.exec(`INSERT INTO users(user_id,email,state,created_at) VALUES (?,?,?,?)`, crypto.randomUUID(), address, "unknown", Date.now());
      state.storage.sql.exec(`DELETE FROM shard_auth_marker WHERE slot=1`);
    });
    await expect(local(target, (instance) => instance.sealInviteInventory(competing, address, "excluded", last))).rejects.toThrow(/requires review/);
    await runInDurableObject(target, (_instance, state) => {
      expect(state.storage.sql.exec(`SELECT operation_id FROM shard_invite_inventory WHERE operation_id=?`, competing).toArray()).toHaveLength(0);
      state.storage.sql.exec(`DELETE FROM users WHERE state='unknown'`);
    });
    expect((await target.sealInviteInventory(competing, address, "excluded", last)).state).toBe("active");
    await target.closeInviteInventory(competing, last, last + 1);
  });

  it("does not treat an empty or oversized stored email as proof of unrelatedness", async () => {
    const target = shard(8), address = email(), first = (await floor(target)) + 10;
    for (const badEmail of ["  ", "x".repeat(321)]) {
      const badUser = crypto.randomUUID(), op = crypto.randomUUID();
      await runInDurableObject(target, (_instance, state) => state.storage.sql.exec(
        `INSERT INTO users(user_id,email,state,created_at) VALUES (?,?,'active',?)`, badUser, badEmail, Date.now(),
      ));
      try {
        await expect(local(target, (instance) => instance.sealInviteInventory(op, address, "excluded", first)))
          .rejects.toThrow(/requires review/);
      } finally {
        await runInDurableObject(target, (_instance, state) => state.storage.sql.exec(`DELETE FROM users WHERE user_id=?`, badUser));
      }
    }
  });

  it("does not exclude a misplaced duplicate user ID on a different shard", async () => {
    const target = shard(15), address = email(), op = crypto.randomUUID(), first = (await floor(target)) + 10;
    const misplaced = `s12:${crypto.randomUUID()}`;
    await runInDurableObject(target, (_instance, state) => state.storage.sql.exec(`INSERT INTO users(user_id,email,state,created_at) VALUES (?,?,?,?)`, misplaced, address, "active", Date.now()));
    expect(await target.sealInviteInventory(op, address, misplaced, first)).toEqual({ state: "active", otherUsers: 1 });
    await target.closeInviteInventory(op, first, first + 1);
  });

  it("does not let another deleting shard account orphan a global account's invitation", async () => {
    const target = shard(9), address = email(), op = crypto.randomUUID(), first = (await floor(target)) + 10;
    const other = await target.signIn(testInput(address, 9));
    await runInDurableObject(target, (_instance, state) =>
      state.storage.sql.exec(`UPDATE users SET state='deleting' WHERE user_id=?`, other.userId));
    // The current product has no account reactivation path. While the seal
    // is held even a direct state change is fenced; mixed-version or restore
    // support must preserve that assumption before rollout.
    expect(await target.sealInviteInventory(op, address, crypto.randomUUID(), first)).toEqual({ state: "active", otherUsers: 0 });
    await runInDurableObject(target, (_instance, state) => {
      expect(() => state.storage.sql.exec(`UPDATE users SET state='active' WHERE user_id=?`, other.userId)).toThrow(/invite_inventory_sealed/);
    });
    await target.closeInviteInventory(op, first, first + 1);
  });
});
