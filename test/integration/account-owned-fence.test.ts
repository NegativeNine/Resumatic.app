import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { vaultPrefix } from "../../src/shared/r2";

async function account(directory: ReturnType<typeof env.DIRECTORY.getByName>) {
  const email = `${crypto.randomUUID()}@example.test`;
  return directory.signIn({ provider: "test", subject: email, email, hint: "enam" });
}

it("does not close or sweep another owner's active Vault through a wrong Directory mapping", async () => {
  const home = env.DIRECTORY.getByName(`account-wrong-owner-${crypto.randomUUID()}`);
  const other = env.DIRECTORY.getByName(`account-victim-${crypto.randomUUID()}`);
  const caller = await account(home), victim = await account(other);
  const victimVault = env.VAULT.get(env.VAULT.idFromString(victim.vaultId));
  const key = `${vaultPrefix(victim.vaultId)}sources/synthetic`;
  await env.FILES.put(key, "synthetic source");
  await runInDurableObject(home, async (instance, state) => {
    state.storage.sql.exec(`UPDATE vaults SET vault_id=? WHERE vault_id=?`, victim.vaultId, caller.vaultId);
    await expect(instance.deleteAccount(caller.userId, victim.vaultId)).rejects.toThrow(/ownership requires review/);
    await instance.alarm();
    expect(state.storage.sql.exec<{state:string}>(`SELECT state FROM vaults WHERE vault_id=?`, victim.vaultId).one().state).toBe("deleting");
  });
  expect(await env.FILES.get(key)).not.toBeNull();
  expect(await runInDurableObject(victimVault, (_vault, state) =>
    state.storage.sql.exec<{value:string}>(`SELECT value FROM meta WHERE key='state'`).one().value,
  )).toBe("open");
});

it("requires a matching live owner and closure for account deletion operations", async () => {
  const id = env.VAULT.newUniqueId(), stub = env.VAULT.get(id), owner = crypto.randomUUID();
  await runInDurableObject(stub, async (instance) => {
    expect(() => instance.quiesceForAccountDeletion(owner)).toThrow(/ownership requires review/);
    await instance.init(owner);
    expect(() => instance.quiesceForAccountDeletion("other-owner")).toThrow(/ownership requires review/);
    expect(() => instance.knownBillingForAccountDeletion("other-owner")).toThrow(/ownership requires review/);
    expect(() => instance.destroyForAccountDeletion(owner)).toThrow(/must be closed/);
    instance.quiesceForAccountDeletion(owner);
    await instance.closeForAccountDeletion(owner);
    await instance.destroyForAccountDeletion(owner);
  });
  await evictDurableObject(stub);
  await runInDurableObject(stub, (instance) => {
    expect(() => instance.quiesceForAccountDeletion(owner)).toThrow(/ownership requires review/);
    expect(() => instance.destroyForAccountDeletion(owner)).toThrow(/ownership requires review/);
  });
});

it("does not start cleanup after the Directory owner changes while quiescence is in flight", async () => {
  const home = env.DIRECTORY.getByName(`account-owner-race-${crypto.randomUUID()}`);
  const originalOwner = await account(home), otherUserId = crypto.randomUUID();
  const key = `${vaultPrefix(originalOwner.vaultId)}sources/synthetic`;
  await env.FILES.put(key, "synthetic source");
  await home.deleteAccount(originalOwner.userId, originalOwner.vaultId);
  await runInDurableObject(home, async (instance, state) => {
    const local = (instance as unknown as { env: Env }).env;
    const original = local.VAULT;
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    local.VAULT = {
      idFromString: (value: string) => original.idFromString(value),
      get: (id: DurableObjectId) => {
        const target = original.get(id);
        if (id.toString() !== originalOwner.vaultId) return target;
        return { quiesceForAccountDeletion: async (userId: string) => {
          await target.quiesceForAccountDeletion(userId);
          entered(); await held;
        } };
      },
    } as unknown as typeof original;
    const pending = instance.alarm();
    try {
      await ready;
      state.storage.sql.exec(`INSERT INTO users(user_id,email,state,created_at) VALUES (?,?,'deleting',?)`, otherUserId, `${otherUserId}@example.test`, Date.now());
      state.storage.sql.exec(`UPDATE vaults SET user_id=? WHERE vault_id=?`, otherUserId, originalOwner.vaultId);
      release();
      await pending;
      expect(state.storage.sql.exec<{state:string}>(`SELECT state FROM vaults WHERE vault_id=?`, originalOwner.vaultId).one().state).toBe("deleting");
    } finally { release(); await pending.catch(() => {}); local.VAULT = original; }
  });
  expect(await env.FILES.get(key)).not.toBeNull();
}, 15_000);

it("leaves account deletion pending when the owner-bound destroy acknowledgement is lost", async () => {
  const home = env.DIRECTORY.getByName(`account-destroy-ack-${crypto.randomUUID()}`);
  const user = await account(home);
  await home.deleteAccount(user.userId, user.vaultId);
  await runInDurableObject(home, async (instance, state) => {
    const local = (instance as unknown as { env: Env }).env;
    const original = local.VAULT;
    local.VAULT = {
      idFromString: (value: string) => original.idFromString(value),
      get: (id: DurableObjectId) => {
        const target = original.get(id);
        return {
          quiesceForAccountDeletion: (owner: string) => target.quiesceForAccountDeletion(owner),
          knownBillingForAccountDeletion: (owner: string) => target.knownBillingForAccountDeletion(owner),
          knownRunsForAccountDeletion: (owner: string) => target.knownRunsForAccountDeletion(owner),
          closeForAccountDeletion: (owner: string) => target.closeForAccountDeletion(owner),
          billingCustomerForAccountDeletion: (owner: string) => target.billingCustomerForAccountDeletion(owner),
          billingCheckoutSessionsForAccountDeletion: (owner: string) => target.billingCheckoutSessionsForAccountDeletion(owner),
          destroyForAccountDeletion: async (owner: string) => {
            await target.destroyForAccountDeletion(owner);
            throw new Error("synthetic acknowledgement lost");
          },
        };
      },
    } as unknown as typeof original;
    try {
      await instance.alarm();
    } finally { local.VAULT = original; }
    expect(state.storage.sql.exec<{state:string}>(`SELECT state FROM vaults WHERE vault_id=?`, user.vaultId).one().state).toBe("deleting");
    await instance.alarm();
    expect(state.storage.sql.exec<{state:string}>(`SELECT state FROM vaults WHERE vault_id=?`, user.vaultId).one().state).toBe("deleting");
  });
});
