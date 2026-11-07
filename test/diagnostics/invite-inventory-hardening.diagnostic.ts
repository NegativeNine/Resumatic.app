import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Directory } from "../../src/directory/directory";
import { directory } from "../../src/shared/stubs";
import { InviteInventory, INVITE_INVENTORY_MIGRATIONS } from "../support/invite-inventory-prototype";

// Test-only primitives on real Directory schemas. This is not coordinator
// wiring and must not be treated as authority to remove an invitation.
const shard = () => env.DIRECTORY.getByName("directory-13");
const email = () => `inventory-${crypto.randomUUID()}@example.test`;
const testInput = (address: string, epoch?: number) => ({ provider: "test" as const, subject: crypto.randomUUID(), email: address, hint: "enam" as const, homeShard: 13, authEpoch: epoch });
const googleInput = (address: string, epoch: number) => ({ ...testInput(address, epoch), provider: "google" as const, inviteAuthorized: true });

async function install(target: ReturnType<typeof shard>) {
  await target.existingIdentity("google", crypto.randomUUID());
  await runInDurableObject(target, (_instance, ctx) => ctx.storage.transactionSync(() => {
    if (!ctx.storage.sql.exec(`SELECT name FROM sqlite_master WHERE type='table' AND name='shard_invite_inventory'`).toArray().length)
      for (const statement of INVITE_INVENTORY_MIGRATIONS) ctx.storage.sql.exec(statement);
  }));
}

function inventory(ctx: DurableObjectState) {
  return new InviteInventory(ctx.storage.sql, (fn) => ctx.storage.transactionSync(fn), () => {
    const raw = ctx.storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='shard_auth_floor'`).one().value;
    const floor = Number(raw);
    if (!/^(?:0|[1-9]\d*)$/.test(raw) || !Number.isSafeInteger(floor)) throw new Error("invalid floor");
    return floor;
  });
}

describe("diagnostic shard invitation inventory primitive", () => {
  it("holds an immutable inventory through retries and requires a later epoch after release", async () => {
    const target = shard(), address = email(), op = crypto.randomUUID();
    await install(target);
    const other = await target.signIn(testInput(address));
    const excluded = await target.signIn(testInput(address));
    const base = await directory(env).googleAuthEpoch(), first = base + 10, last = base + 11;
    await runInDurableObject(target, async (instance, ctx) => {
      const probe = inventory(ctx), receipt = { state: "active", otherUsers: 1 };
      expect(probe.seal(op, address, excluded.userId, first)).toEqual(receipt);
      expect(probe.seal(op, address.toUpperCase(), excluded.userId, first)).toEqual(receipt);
      expect(() => probe.seal(op, address, other.userId, first)).toThrow(/changed/);
      await expect((instance as Directory).signIn(googleInput(email(), first))).rejects.toThrow(/invite_inventory_sealed/);
      expect(() => ctx.storage.sql.exec(`UPDATE users SET email=? WHERE user_id=?`, email(), other.userId)).toThrow(/invite_inventory_sealed/);
      expect(() => ctx.storage.sql.exec(`DELETE FROM users WHERE user_id=?`, other.userId)).toThrow(/invite_inventory_sealed/);
      expect(() => probe.close(op, first, first)).toThrow(/invalid/);
      probe.close(op, first, last);
      probe.close(op, first, last); // lost close acknowledgement
      expect(probe.seal(op, address, excluded.userId, first)).toEqual({ state: "closed" });
      await expect((instance as Directory).signIn(googleInput(email(), first))).rejects.toThrow(/stale/);
      expect((await (instance as Directory).signIn(googleInput(email(), last))).userId).toBeTruthy();
      // Unlike Google, the current test-provider route never creates an epoch
      // marker. The permanent insertion guard deliberately blocks that route:
      // staging would need its own authorization protocol before integration.
      await expect((instance as Directory).signIn(testInput(email(), last))).rejects.toThrow(/epoch_required/);
      const row = ctx.storage.sql.exec<{ email: string | null; excluded_user_id: string | null; other_users: number | null }>(`SELECT email,excluded_user_id,other_users FROM shard_invite_inventory WHERE operation_id=?`, op).one();
      expect(row).toEqual({ email: null, excluded_user_id: null, other_users: null });
      expect(() => ctx.storage.sql.exec(`INSERT INTO users(user_id,email,state,created_at) VALUES (?,?,?,?)`, crypto.randomUUID(), email(), "active", Date.now())).toThrow(/epoch_required/);
    });
  });

  it("tombstones a close before a delayed seal and rejects conflicting closes", async () => {
    const target = shard(), op = crypto.randomUUID(), address = email();
    await install(target);
    const base = await directory(env).googleAuthEpoch(), first = base + 20, last = base + 21;
    await runInDurableObject(target, async (instance, ctx) => {
      const probe = inventory(ctx);
      probe.close(op, first, last);
      expect(probe.seal(op, address, "old-user", first)).toEqual({ state: "closed" });
      expect(() => probe.seal(op, address, "old-user", first + 1)).toThrow(/changed/);
      expect(() => probe.close(op, first, last + 1)).toThrow(/changed/);
      await expect((instance as Directory).signIn(googleInput(email(), first))).rejects.toThrow(/stale/);
      expect((await (instance as Directory).signIn(googleInput(email(), last))).userId).toBeTruthy();
    });
  });

  it("serializes seals and rolls back malformed inventory without retaining a seal", async () => {
    const target = shard(), address = email(), op = crypto.randomUUID(), competing = crypto.randomUUID();
    await install(target);
    const base = await directory(env).googleAuthEpoch(), first = base + 30, last = base + 31;
    await runInDurableObject(target, (_instance, ctx) => {
      const probe = inventory(ctx);
      probe.seal(op, address, "excluded", first);
      expect(() => probe.seal(competing, address, "excluded", first)).toThrow(/busy/);
      probe.close(op, first, last);
      ctx.storage.sql.exec(`INSERT INTO shard_auth_marker(slot,epoch) VALUES (1,?)`, last);
      ctx.storage.sql.exec(`INSERT INTO users(user_id,email,state,created_at) VALUES (?,?,?,?)`, crypto.randomUUID(), address, "unknown", Date.now());
      ctx.storage.sql.exec(`DELETE FROM shard_auth_marker WHERE slot=1`);
      expect(() => probe.seal(competing, address, "excluded", last)).toThrow(/requires review/);
      expect(ctx.storage.sql.exec(`SELECT operation_id FROM shard_invite_inventory WHERE operation_id=?`, competing).toArray()).toHaveLength(0);
      ctx.storage.sql.exec(`DELETE FROM users WHERE state='unknown'`);
      expect(probe.seal(competing, address, "excluded", last).state).toBe("active");
      probe.close(competing, last, last + 1);
    });
  });
});
