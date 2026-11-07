import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { vaultPrefix } from "../../src/shared/r2";

async function account(directory: ReturnType<typeof env.DIRECTORY.getByName>) {
  const email = `${crypto.randomUUID()}@example.test`;
  return directory.signIn({ provider: "test", subject: email, email, hint: "enam" });
}

it("rejects retirement of another Directory's live Vault before changing its state or files", async () => {
  const home = env.DIRECTORY.getByName(`retired-home-${crypto.randomUUID()}`);
  const other = env.DIRECTORY.getByName(`retired-other-${crypto.randomUUID()}`);
  const owner = await account(home), victim = await account(other);
  const victimVault = env.VAULT.get(env.VAULT.idFromString(victim.vaultId));
  const key = `${vaultPrefix(victim.vaultId)}sources/synthetic`;
  await env.FILES.put(key, "synthetic source");
  await runInDurableObject(home, async (instance, state) => {
    state.storage.sql.exec(`INSERT INTO retired_vaults(vault_id,user_id) VALUES (?,?)`, victim.vaultId, owner.userId);
    await instance.alarm();
    expect(state.storage.sql.exec<{state:string}>(`SELECT state FROM retired_vaults WHERE vault_id=?`, victim.vaultId).one().state).toBe("deleting");
  });
  expect(await env.FILES.get(key)).not.toBeNull();
  expect(await runInDurableObject(victimVault, (_vault, state) => state.storage.sql.exec<{value:string}>(`SELECT value FROM meta WHERE key='state'`).one().value)).toBe("open");
});

it("requires a persisted matching owner and a closing state for retirement operations", async () => {
  const id = env.VAULT.newUniqueId(), stub = env.VAULT.get(id), owner = crypto.randomUUID();
  await runInDurableObject(stub, async (instance) => {
    expect(() => instance.quiesceForRetirement(owner)).toThrow(/ownership requires review/);
    await instance.init(owner);
    expect(() => instance.quiesceForRetirement("different-owner")).toThrow(/ownership requires review/);
    expect(() => instance.destroyForRetirement(owner)).toThrow(/must be closed/);
    instance.quiesceForRetirement(owner);
    await expect(instance.init(owner)).rejects.toThrow(/closing/);
    await instance.closeForRetirement(owner);
    await instance.destroyForRetirement(owner);
  });
  await evictDurableObject(stub);
  await runInDurableObject(stub, (instance) => {
    expect(() => instance.quiesceForRetirement(owner)).toThrow(/ownership requires review/);
    expect(() => instance.destroyForRetirement(owner)).toThrow(/ownership requires review/);
  });
});

it("preserves a legacy already-swept retirement without owner proof", async () => {
  const directory = env.DIRECTORY.getByName(`retired-legacy-${crypto.randomUUID()}`);
  const id = env.VAULT.newUniqueId(), stub = env.VAULT.get(id), owner = crypto.randomUUID();
  await stub.init(owner);
  await stub.destroy();
  const key = `${vaultPrefix(id.toString())}sources/synthetic`;
  await env.FILES.put(key, "synthetic legacy file");
  await runInDurableObject(directory, async (instance, state) => {
    state.storage.sql.exec(`INSERT INTO retired_vaults(vault_id,user_id,state,swept_at) VALUES (?,?,'swept',1)`, id.toString(), owner);
    await instance.alarm();
    expect(state.storage.sql.exec(`SELECT vault_id FROM retired_vaults WHERE vault_id=?`, id.toString()).toArray()).toHaveLength(1);
  });
  expect(await env.FILES.get(key)).not.toBeNull();
});

it("keeps retirement pending after its owner-bound destroy acknowledgement is lost", async () => {
  const directory = env.DIRECTORY.getByName(`retired-lost-ack-${crypto.randomUUID()}`);
  const id = env.VAULT.newUniqueId(), owner = crypto.randomUUID();
  await env.VAULT.get(id).init(owner);
  await runInDurableObject(directory, async (instance, state) => {
    const local = (instance as unknown as { env: Env }).env;
    const original = local.VAULT, oldDelay = local.SWEEP_DELAY_MS;
    local.SWEEP_DELAY_MS = "0";
    local.VAULT = {
      idFromString: (value: string) => original.idFromString(value),
      get: (value: DurableObjectId) => {
        const target = original.get(value);
        return {
          quiesceForRetirement: (userId: string) => target.quiesceForRetirement(userId),
          knownRunsForRetirement: (userId: string) => target.knownRunsForRetirement(userId),
          closeForRetirement: (userId: string) => target.closeForRetirement(userId),
          destroyForRetirement: async (userId: string) => {
            await target.destroyForRetirement(userId);
            throw new Error("synthetic acknowledgement lost");
          },
        };
      },
    } as unknown as typeof original;
    try {
      state.storage.sql.exec(`INSERT INTO retired_vaults(vault_id,user_id) VALUES (?,?)`, id.toString(), owner);
      await instance.alarm();
      const first = state.storage.sql.exec<{state:string;generation:string}>(`SELECT state,generation FROM retired_vaults WHERE vault_id=?`, id.toString()).one();
      expect(first.state).toBe("awaiting_final_sweep");
      await instance.alarm();
      expect(state.storage.sql.exec<{state:string;generation:string}>(`SELECT state,generation FROM retired_vaults WHERE vault_id=?`, id.toString()).one()).toEqual(first);
    } finally { local.VAULT = original; local.SWEEP_DELAY_MS = oldDelay; }
  });
});

it("does not advance a replaced retirement row after an earlier R2 sweep returns", async () => {
  const directory = env.DIRECTORY.getByName(`retired-generation-${crypto.randomUUID()}`);
  const id = env.VAULT.newUniqueId(), owner = crypto.randomUUID();
  const stub = env.VAULT.get(id);
  await stub.init(owner);
  await runInDurableObject(directory, async (instance, state) => {
    const local = (instance as unknown as { env: Env }).env, original = local.FILES;
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let first = true;
    local.FILES = {
      list: async (options: R2ListOptions) => {
        if (first) { first = false; entered(); await hold; }
        return original.list(options);
      },
      delete: (keys: string | string[]) => original.delete(keys),
    } as unknown as R2Bucket;
    state.storage.sql.exec(`INSERT INTO retired_vaults(vault_id,user_id) VALUES (?,?)`, id.toString(), owner);
    const pending = instance.alarm();
    try {
      await ready;
      const old = state.storage.sql.exec<{generation:string}>(`SELECT generation FROM retired_vaults WHERE vault_id=?`, id.toString()).one().generation;
      expect(old).toBeTruthy();
      state.storage.sql.exec(`DELETE FROM retired_vaults WHERE vault_id=?`, id.toString());
      state.storage.sql.exec(`INSERT INTO retired_vaults(vault_id,user_id) VALUES (?,?)`, id.toString(), owner);
      release(); await pending;
      expect(state.storage.sql.exec<{state:string;generation:string|null}>(`SELECT state,generation FROM retired_vaults WHERE vault_id=?`, id.toString()).one())
        .toEqual({ state: "deleting", generation: null });
    } finally { release(); await pending.catch(() => {}); local.FILES = original; }
  });
  expect(await runInDurableObject(stub, (_vault, state) => state.storage.sql.exec<{value:string}>(`SELECT value FROM meta WHERE key='state'`).one().value)).toBe("closing");
});

it("rejects a noncanonical uppercase retired ID instead of sweeping a different R2 prefix", async () => {
  const directory = env.DIRECTORY.getByName(`retired-case-${crypto.randomUUID()}`);
  let id = env.VAULT.newUniqueId();
  while (id.toString() === id.toString().toUpperCase()) id = env.VAULT.newUniqueId();
  const stub = env.VAULT.get(id), owner = crypto.randomUUID();
  await stub.init(owner);
  const key = `${vaultPrefix(id.toString())}sources/synthetic`;
  await env.FILES.put(key, "synthetic source");
  await runInDurableObject(directory, async (instance, state) => {
    state.storage.sql.exec(`INSERT INTO retired_vaults(vault_id,user_id) VALUES (?,?)`, id.toString().toUpperCase(), owner);
    await instance.alarm();
    expect(state.storage.sql.exec(`SELECT vault_id FROM retired_vaults WHERE vault_id=?`, id.toString().toUpperCase()).toArray()).toHaveLength(1);
  });
  expect(await env.FILES.get(key)).not.toBeNull();
  expect(await runInDurableObject(stub, (_vault, state) => state.storage.sql.exec<{value:string}>(`SELECT value FROM meta WHERE key='state'`).one().value)).toBe("open");
});

it.each([null, 0, -1, 1.5])("holds retired and current swept rows with an invalid timestamp (%s)", async (timestamp) => {
  const directory = env.DIRECTORY.getByName(`retired-time-${crypto.randomUUID()}`);
  const user = await account(directory), retiredId = env.VAULT.newUniqueId();
  const retired = env.VAULT.get(retiredId);
  await retired.init(user.userId);
  await retired.quiesceForRetirement(user.userId);
  const retiredKey = `${vaultPrefix(retiredId.toString())}sources/synthetic`;
  await env.FILES.put(retiredKey, "synthetic source");
  await runInDurableObject(directory, async (instance, state) => {
    state.storage.sql.exec(`INSERT INTO retired_vaults(vault_id,user_id,state,swept_at) VALUES (?,?,'awaiting_final_sweep',?)`, retiredId.toString(), user.userId, timestamp);
    state.storage.sql.exec(`UPDATE vaults SET state='swept',swept_at=? WHERE vault_id=?`, timestamp, user.vaultId);
    await instance.alarm();
    expect(state.storage.sql.exec(`SELECT user_id FROM users WHERE user_id=?`, user.userId).toArray()).toHaveLength(1);
    expect(state.storage.sql.exec(`SELECT vault_id FROM retired_vaults WHERE vault_id=?`, retiredId.toString()).toArray()).toHaveLength(1);
    expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
  });
  expect(await env.FILES.get(retiredKey)).not.toBeNull();
});
