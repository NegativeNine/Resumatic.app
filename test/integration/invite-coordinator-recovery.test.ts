import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { InviteCoordinator, type InventoryIdentity } from "../../src/directory/invite-coordinator";

const id = (): InventoryIdentity => ({ operationId: crypto.randomUUID(), userId: crypto.randomUUID(), vaultId: "vault", email: "person@example.test", finalGeneration: crypto.randomUUID() });
const nextTick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

it("closes every shard on a timed-out seal, then retries with a fresh attempt ID; late replies cannot settle the retry", async () => {
  const stub = env.DIRECTORY.get(env.DIRECTORY.idFromName(`inventory-recovery-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_instance, ctx) => {
    const sql = ctx.storage.sql;
    sql.exec(`INSERT INTO meta(key,value) VALUES ('global_auth_epoch','1')`);
    let unblockOld!: () => void, unblockNew!: () => void;
    const old = new Promise<void>((resolve) => { unblockOld = resolve; });
    const newer = new Promise<void>((resolve) => { unblockNew = resolve; });
    const attempts: string[] = [], closed = new Map<string, Set<number>>();
    let calls = 0, decisions = 0, finished = 0;
    const c = new InviteCoordinator({ sql, storage: ctx.storage,
      transaction: (fn) => ctx.storage.transactionSync(fn),
      epoch: () => Number(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='global_auth_epoch'`).one().value),
      validate: () => {}, decide: () => { decisions++; }, finish: () => { finished++; }, sealWaitMs: 20,
      seal: async (shard, _identity, attempt) => {
        if (!attempts.includes(attempt)) attempts.push(attempt);
        if (shard === 0) { if (++calls === 1) await old; else await newer; }
        return { state: "active" as const, otherUsers: 0 };
      },
      close: async (shard, attempt) => { const set = closed.get(attempt) ?? new Set<number>(); set.add(shard); closed.set(attempt, set); },
    });
    const target = id();
    await c.begin(target);
    expect(await ctx.storage.getAlarm()).not.toBeNull();
    await c.resume();
    expect(c.active()).toBe(false);
    expect(closed.get(attempts[0]!)?.size).toBe(16);
    expect(decisions).toBe(0);
    await c.begin(target);
    const retry = c.resume();
    await nextTick();
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).not.toBe(attempts[1]);
    unblockOld();
    await nextTick();
    expect(sql.exec(`SELECT shard FROM invite_inventory_receipts WHERE operation_id=? AND shard=0`, attempts[1]).toArray()).toHaveLength(0);
    unblockNew();
    await retry;
    expect(c.active()).toBe(false);
    expect(decisions).toBe(1);
    expect(finished).toBe(1);
    expect(closed.get(attempts[1]!)?.size).toBe(16);
  });
});

it("retains the barrier after an unknown close reply and resumes idempotently", async () => {
  const stub = env.DIRECTORY.get(env.DIRECTORY.idFromName(`inventory-close-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_instance, ctx) => {
    const sql = ctx.storage.sql;
    sql.exec(`INSERT INTO meta(key,value) VALUES ('global_auth_epoch','1')`);
    let allow = false, decisions = 0, finished = 0;
    const c = new InviteCoordinator({ sql, storage: ctx.storage,
      transaction: (fn) => ctx.storage.transactionSync(fn),
      epoch: () => Number(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='global_auth_epoch'`).one().value),
      validate: () => {}, decide: () => { decisions++; }, finish: () => { finished++; }, sealWaitMs: 20,
      seal: async () => ({ state: "active" as const, otherUsers: 0 }),
      close: async (shard) => { if (shard === 0 && !allow) throw new Error("lost acknowledgement"); },
    });
    await c.begin(id());
    await Promise.all([c.resume(), c.resume()]);
    expect(c.active()).toBe(true);
    expect(decisions).toBe(1);
    expect(finished).toBe(0);
    expect(sql.exec<{ n: number }>(`SELECT count(*) AS n FROM invite_inventory_receipts WHERE closed=1`).one().n).toBe(15);
    allow = true;
    await Promise.all([c.resume(), c.resume()]);
    expect(c.active()).toBe(false);
    expect(decisions).toBe(1);
    expect(finished).toBe(1);
  });
});

it("requires a versioned proof from the exact target shard before deciding", async () => {
  const stub = env.DIRECTORY.get(env.DIRECTORY.idFromName(`inventory-target-${crypto.randomUUID()}`));
  await runInDurableObject(stub, async (_instance, ctx) => {
    const sql = ctx.storage.sql;
    sql.exec(`INSERT INTO meta(key,value) VALUES ('global_auth_epoch','1')`);
    let proof = false, invalidOther = false, decisions = 0, finished = 0;
    const closed: string[] = [];
    const c = new InviteCoordinator({ sql, storage: ctx.storage,
      transaction: (fn) => ctx.storage.transactionSync(fn),
      epoch: () => Number(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='global_auth_epoch'`).one().value),
      validate: () => {}, decide: () => { decisions++; }, finish: () => { finished++; }, sealWaitMs: 30,
      seal: async (shard) => ({ state: "active" as const, otherUsers: 0,
        ...(shard === 5 && proof ? { targetVerified: true } : {}),
        ...(shard === 4 && invalidOther ? { targetVerified: "invalid" as unknown as boolean } : {}),
      }),
      close: async (shard, attempt) => { closed.push(`${attempt}:${shard}`); },
    });
    const target = { ...id(), userId: `s5:${crypto.randomUUID()}` };
    await c.begin(target);
    await c.resume();
    expect(decisions).toBe(0);
    expect(finished).toBe(0);
    expect(c.active()).toBe(false);
    expect(closed).toHaveLength(16);
    proof = true;
    await c.begin(target);
    // A count persisted by an older coordinator is not a target proof.
    const attempt = sql.exec<{ attempt_id: string }>(`SELECT attempt_id FROM invite_inventory_barrier WHERE slot=1`).one().attempt_id;
    sql.exec(`INSERT INTO invite_inventory_receipts(operation_id,shard,other_users) VALUES (?,5,0)`, attempt);
    await c.resume();
    expect(decisions).toBe(0);
    expect(c.active()).toBe(false);
    expect(closed).toHaveLength(32);
    invalidOther = true;
    await c.begin(target);
    await c.resume();
    expect(decisions).toBe(0);
    expect(c.active()).toBe(false);
    expect(closed).toHaveLength(48);
    invalidOther = false;
    await c.begin(target);
    await c.resume();
    expect(decisions).toBe(1);
    expect(finished).toBe(1);
    expect(c.active()).toBe(false);
    expect(closed).toHaveLength(64);
  });
});

it("rolls back barrier and epoch if arming the recovery alarm fails", async () => {
  for (const failure of ["get", "set"] as const) {
    const stub = env.DIRECTORY.get(env.DIRECTORY.idFromName(`inventory-alarm-${failure}-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (_instance, ctx) => {
      const sql = ctx.storage.sql;
      sql.exec(`INSERT INTO meta(key,value) VALUES ('global_auth_epoch','1')`);
      const storage = {
        transaction: (fn: () => Promise<unknown>) => ctx.storage.transaction(fn),
        getAlarm: async () => { if (failure === "get") throw new Error("get alarm failed"); return null; },
        setAlarm: async () => { throw new Error("set alarm failed"); },
      } as unknown as DurableObjectStorage;
      const c = new InviteCoordinator({ sql, storage,
        transaction: (fn) => ctx.storage.transactionSync(fn),
        epoch: () => Number(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='global_auth_epoch'`).one().value),
        validate: () => {}, decide: () => {}, finish: () => {},
        seal: async () => { throw new Error("unexpected seal"); }, close: async () => { throw new Error("unexpected close"); },
      });
      await expect(c.begin(id())).rejects.toThrow(/alarm failed/);
      expect(c.active()).toBe(false);
      expect(sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='global_auth_epoch'`).one().value).toBe("1");
      expect(sql.exec(`SELECT key FROM meta WHERE key='invite_inventory_epoch_guard'`).toArray()).toHaveLength(0);
      expect(await ctx.storage.getAlarm()).toBeNull();
    });
  }
});
