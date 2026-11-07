import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Directory } from "../../src/directory/directory";
import { directory } from "../../src/shared/stubs";

it("lets a cold shard obtain its fixed rollout floor while the global inventory is sealed", async () => {
  const global = directory(env), shard = env.DIRECTORY.getByName("directory-9");
  const attempt = crypto.randomUUID(), operation = crypto.randomUUID(), address = `${attempt}@example.test`;
  const epoch = (await global.googleAuthEpoch()) + 1;
  await runInDurableObject(global, (_instance, state) => {
    state.storage.sql.exec(`UPDATE meta SET value=? WHERE key='global_auth_epoch'`, String(epoch));
    state.storage.sql.exec(`INSERT INTO invite_inventory_barrier(slot,operation_id,attempt_id,user_id,vault_id,email,final_generation,seal_epoch,phase)
      VALUES (1,?,?,?,?,?,?,?,'sealing')`, operation, attempt, crypto.randomUUID(), env.VAULT.newUniqueId().toString(), address, crypto.randomUUID(), epoch);
  });
  try {
    // First contact initializes the shard inside blockConcurrencyWhile(). Its
    // bootstrap reads the historical rollout floor from the global Directory.
    expect(await shard.sealInviteInventory(attempt, address, crypto.randomUUID(), epoch)).toEqual({ state: "active", otherUsers: 0 });
    await shard.closeInviteInventory(attempt, epoch, epoch + 1);
  } finally {
    await runInDurableObject(global, (_instance, state) => state.storage.sql.exec(`DELETE FROM invite_inventory_barrier WHERE slot=1 AND attempt_id=?`, attempt));
  }
}, 30_000);

it("rejects delayed non-Google authorizations on both existing and new global accounts after a barrier", async () => {
  const global = directory(env), stale = await global.googleAuthEpoch(), id = crypto.randomUUID();
  const input = { provider: "test" as const, subject: id, email: `${id}@example.test`, hint: "enam" as const, authEpoch: stale };
  await global.signIn(input);
  await runInDurableObject(global, (_instance, state) => {
    // Model the durable floor remaining after the barrier is released.
    state.storage.sql.exec(`UPDATE meta SET value=? WHERE key='global_auth_epoch'`, String(stale + 2));
    state.storage.sql.exec(`INSERT INTO meta(key,value) VALUES ('invite_inventory_epoch_guard','1') ON CONFLICT(key) DO UPDATE SET value='1'`);
  });
  await runInDurableObject(global, async (instance) => {
    const d = instance as Directory;
    await expect(d.signIn(input)).rejects.toThrow(/stale/);
    await expect(d.signIn({ ...input, subject: crypto.randomUUID() })).rejects.toThrow(/stale/);
    expect((await d.signIn({ ...input, authEpoch: stale + 2 })).userId).toBeTruthy();
  });
}, 30_000);
