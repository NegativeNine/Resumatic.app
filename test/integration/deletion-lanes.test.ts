import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { vaultPrefix } from "../../src/shared/r2";

async function account(directory: ReturnType<typeof env.DIRECTORY.getByName>) {
  const email = `${crypto.randomUUID()}@example.test`;
  return directory.signIn({ provider: "test", subject: email, email, hint: "enam" });
}

function heldListing(bucket: R2Bucket, prefix: string) {
  let entered!: () => void;
  let release!: () => void;
  let held = false;
  const ready = new Promise<void>((resolve) => { entered = resolve; });
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const files = {
    list: async (options: R2ListOptions) => {
      if (options.prefix === prefix && !held) {
        held = true;
        entered();
        await pending;
      }
      return bucket.list(options);
    },
    delete: (keys: string | string[]) => bucket.delete(keys),
  } as unknown as R2Bucket;
  return { files, ready, release };
}

it("finishes a previously swept account while an unrelated deleting vault is stalled", async () => {
  const directory = env.DIRECTORY.getByName(`deletion-lanes-${crypto.randomUUID()}`);
  const first = await account(directory), second = await account(directory);
  await runInDurableObject(directory, async (instance, state) => {
    const local = (instance as unknown as { env: Env }).env;
    const oldDelay = local.SWEEP_DELAY_MS, oldFiles = local.FILES;
    local.SWEEP_DELAY_MS = "3600000";
    let running: Promise<void> | undefined;
    let release: (() => void) | undefined;
    try {
      await instance.deleteAccount(first.userId, first.vaultId);
      await instance.alarm();
      expect(state.storage.sql.exec<{ state: string }>(`SELECT state FROM vaults WHERE vault_id=?`, first.vaultId).one().state).toBe("swept");
      await instance.deleteAccount(second.userId, second.vaultId);
      local.SWEEP_DELAY_MS = "0";
      const held = heldListing(oldFiles, vaultPrefix(second.vaultId));
      local.FILES = held.files;
      release = held.release;
      running = instance.alarm();
      await held.ready;
      for (let i = 0; i < 100 && state.storage.sql.exec(`SELECT user_id FROM users WHERE user_id=?`, first.userId).toArray().length; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(state.storage.sql.exec(`SELECT user_id FROM users WHERE user_id=?`, first.userId).toArray()).toHaveLength(0);
      expect(state.storage.sql.exec<{ state: string }>(`SELECT state FROM vaults WHERE vault_id=?`, second.vaultId).one().state).toBe("deleting");
    } finally {
      release?.();
      await running;
      local.FILES = oldFiles;
      local.SWEEP_DELAY_MS = oldDelay;
    }
  });
}, 30_000);

it("finishes a previously swept account while an unrelated retirement is stalled", async () => {
  const directory = env.DIRECTORY.getByName(`deletion-lanes-${crypto.randomUUID()}`);
  const first = await account(directory), other = await account(directory);
  const retiredId = env.VAULT.newUniqueId();
  await env.VAULT.get(retiredId).init(other.userId);
  await runInDurableObject(directory, async (instance, state) => {
    const local = (instance as unknown as { env: Env }).env;
    const oldDelay = local.SWEEP_DELAY_MS, oldFiles = local.FILES;
    local.SWEEP_DELAY_MS = "3600000";
    let running: Promise<void> | undefined;
    let release: (() => void) | undefined;
    try {
      await instance.deleteAccount(first.userId, first.vaultId);
      await instance.alarm();
      expect(state.storage.sql.exec<{ state: string }>(`SELECT state FROM vaults WHERE vault_id=?`, first.vaultId).one().state).toBe("swept");
      state.storage.sql.exec(`INSERT INTO retired_vaults(vault_id,user_id) VALUES (?,?)`, retiredId.toString(), other.userId);
      local.SWEEP_DELAY_MS = "0";
      const held = heldListing(oldFiles, vaultPrefix(retiredId.toString()));
      local.FILES = held.files;
      release = held.release;
      running = instance.alarm();
      await held.ready;
      for (let i = 0; i < 100 && state.storage.sql.exec(`SELECT user_id FROM users WHERE user_id=?`, first.userId).toArray().length; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(state.storage.sql.exec(`SELECT user_id FROM users WHERE user_id=?`, first.userId).toArray()).toHaveLength(0);
      expect(state.storage.sql.exec<{ state: string }>(`SELECT state FROM retired_vaults WHERE vault_id=?`, retiredId.toString()).one().state).toBe("deleting");
    } finally {
      release?.();
      await running;
      local.FILES = oldFiles;
      local.SWEEP_DELAY_MS = oldDelay;
    }
  });
}, 30_000);

it("finishes a previously swept account after its own retirement without waiting for an unrelated deletion", async () => {
  const directory = env.DIRECTORY.getByName(`deletion-lanes-${crypto.randomUUID()}`);
  const first = await account(directory), second = await account(directory);
  const retiredId = env.VAULT.newUniqueId();
  await env.VAULT.get(retiredId).init(first.userId);
  await runInDurableObject(directory, async (instance, state) => {
    const local = (instance as unknown as { env: Env }).env;
    const oldDelay = local.SWEEP_DELAY_MS, oldFiles = local.FILES;
    local.SWEEP_DELAY_MS = "3600000";
    let running: Promise<void> | undefined;
    let release: (() => void) | undefined;
    try {
      state.storage.sql.exec(`INSERT INTO retired_vaults(vault_id,user_id) VALUES (?,?)`, retiredId.toString(), first.userId);
      await instance.deleteAccount(first.userId, first.vaultId);
      await instance.alarm();
      expect(state.storage.sql.exec<{ state: string }>(`SELECT state FROM vaults WHERE vault_id=?`, first.vaultId).one().state).toBe("swept");
      expect(state.storage.sql.exec<{ state: string }>(`SELECT state FROM retired_vaults WHERE vault_id=?`, retiredId.toString()).one().state).toBe("awaiting_final_sweep");
      await instance.deleteAccount(second.userId, second.vaultId);
      local.SWEEP_DELAY_MS = "0";
      const held = heldListing(oldFiles, vaultPrefix(second.vaultId));
      local.FILES = held.files;
      release = held.release;
      running = instance.alarm();
      await held.ready;
      for (let i = 0; i < 100 && state.storage.sql.exec(`SELECT user_id FROM users WHERE user_id=?`, first.userId).toArray().length; i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(state.storage.sql.exec(`SELECT vault_id FROM retired_vaults WHERE vault_id=?`, retiredId.toString()).toArray()).toHaveLength(0);
      expect(state.storage.sql.exec(`SELECT user_id FROM users WHERE user_id=?`, first.userId).toArray()).toHaveLength(0);
      expect(state.storage.sql.exec<{ state: string }>(`SELECT state FROM vaults WHERE vault_id=?`, second.vaultId).one().state).toBe("deleting");
    } finally {
      release?.();
      await running;
      local.FILES = oldFiles;
      local.SWEEP_DELAY_MS = oldDelay;
    }
  });
}, 30_000);

it("does not finalize an account until its own retired vault has completed the second sweep", async () => {
  const directory = env.DIRECTORY.getByName(`deletion-lanes-${crypto.randomUUID()}`);
  const user = await account(directory);
  const retiredId = env.VAULT.newUniqueId(), retired = env.VAULT.get(retiredId);
  await retired.init(user.userId);
  await runInDurableObject(directory, async (instance, state) => {
    const local = (instance as unknown as { env: Env }).env;
    const oldDelay = local.SWEEP_DELAY_MS, oldFiles = local.FILES;
    local.SWEEP_DELAY_MS = "3600000";
    let running: Promise<void> | undefined;
    let release: (() => void) | undefined;
    try {
      state.storage.sql.exec(`INSERT INTO retired_vaults(vault_id,user_id) VALUES (?,?)`, retiredId.toString(), user.userId);
      await instance.deleteAccount(user.userId, user.vaultId);
      await instance.alarm();
      expect(state.storage.sql.exec<{ state: string }>(`SELECT state FROM vaults WHERE vault_id=?`, user.vaultId).one().state).toBe("swept");
      expect(state.storage.sql.exec<{ state: string }>(`SELECT state FROM retired_vaults WHERE vault_id=?`, retiredId.toString()).one().state).toBe("awaiting_final_sweep");
      local.SWEEP_DELAY_MS = "0";
      const held = heldListing(oldFiles, vaultPrefix(retiredId.toString()));
      local.FILES = held.files;
      release = held.release;
      running = instance.alarm();
      await held.ready;
      expect(state.storage.sql.exec(`SELECT user_id FROM users WHERE user_id=?`, user.userId).toArray()).toHaveLength(1);
      expect(state.storage.sql.exec(`SELECT vault_id FROM retired_vaults WHERE vault_id=?`, retiredId.toString()).toArray()).toHaveLength(1);
      release();
      release = undefined;
      await running;
      running = undefined;
      expect(state.storage.sql.exec(`SELECT user_id FROM users WHERE user_id=?`, user.userId).toArray()).toHaveLength(0);
      expect(state.storage.sql.exec(`SELECT vault_id FROM retired_vaults WHERE vault_id=?`, retiredId.toString()).toArray()).toHaveLength(0);
      // A duplicate alarm sees no work and must not recreate a retired row or
      // reinitialize either Vault after successful cleanup.
      await instance.alarm();
      expect(state.storage.sql.exec(`SELECT user_id FROM users WHERE user_id=?`, user.userId).toArray()).toHaveLength(0);
      expect(state.storage.sql.exec(`SELECT vault_id FROM retired_vaults WHERE vault_id=?`, retiredId.toString()).toArray()).toHaveLength(0);
    } finally {
      release?.();
      await running;
      local.FILES = oldFiles;
      local.SWEEP_DELAY_MS = oldDelay;
    }
  });
}, 30_000);

it("never retires a current vault or finalizes its owner when an inconsistent retired row uses the same ID", async () => {
  const directory = env.DIRECTORY.getByName(`deletion-lanes-${crypto.randomUUID()}`);
  const user = await account(directory);
  const stub = env.VAULT.get(env.VAULT.idFromString(user.vaultId));
  const key = `${vaultPrefix(user.vaultId)}sources/example`;
  await env.FILES.put(key, "synthetic source");
  await runInDurableObject(directory, async (instance, state) => {
    // A retired ID may not name any current vault, irrespective of a corrupt
    // owner association. Do not close it as a side effect of the alarm.
    state.storage.sql.exec(`INSERT INTO retired_vaults(vault_id,user_id) VALUES (?,?)`, user.vaultId, "inconsistent-owner");
    await instance.alarm();
    expect(state.storage.sql.exec<{ state: string }>(`SELECT state FROM vaults WHERE vault_id=?`, user.vaultId).one().state).toBe("active");
    expect(state.storage.sql.exec(`SELECT vault_id FROM retired_vaults WHERE vault_id=?`, user.vaultId).toArray()).toHaveLength(1);
    // A conflicting retired row also blocks finalization of a swept account,
    // even if the row's user ID is inconsistent.
    state.storage.sql.exec(`UPDATE vaults SET state='swept',swept_at=1 WHERE vault_id=?`, user.vaultId);
    state.storage.sql.exec(`UPDATE users SET state='deleting' WHERE user_id=?`, user.userId);
    await instance.alarm();
    expect(state.storage.sql.exec(`SELECT user_id FROM users WHERE user_id=?`, user.userId).toArray()).toHaveLength(1);
    expect(state.storage.sql.exec(`SELECT vault_id FROM retired_vaults WHERE vault_id=?`, user.vaultId).toArray()).toHaveLength(1);
    expect(await state.storage.getAlarm()).toBeGreaterThan(Date.now());
  });
  expect(await env.FILES.get(key)).not.toBeNull();
  expect(await runInDurableObject(stub, (_vault, ctx) => ctx.storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='state'`).one().value)).toBe("open");
}, 30_000);

it("rechecks retirement state after the final sweep yields", async () => {
  const directory = env.DIRECTORY.getByName(`deletion-lanes-${crypto.randomUUID()}`);
  const user = await account(directory);
  const retiredId = env.VAULT.newUniqueId();
  await env.VAULT.get(retiredId).init(user.userId);
  await runInDurableObject(directory, async (instance, state) => {
    const local = (instance as unknown as { env: Env }).env;
    const oldDelay = local.SWEEP_DELAY_MS, oldFiles = local.FILES;
    local.SWEEP_DELAY_MS = "3600000";
    let running: Promise<void> | undefined;
    let release: (() => void) | undefined;
    try {
      await instance.deleteAccount(user.userId, user.vaultId);
      await instance.alarm();
      expect(state.storage.sql.exec<{ state: string }>(`SELECT state FROM vaults WHERE vault_id=?`, user.vaultId).one().state).toBe("swept");
      local.SWEEP_DELAY_MS = "0";
      const held = heldListing(oldFiles, vaultPrefix(user.vaultId));
      local.FILES = held.files;
      release = held.release;
      running = instance.alarm();
      await held.ready;
      // Simulate a legacy or concurrent path discovering a retirement after
      // the first check but before the final Directory transaction.
      state.storage.sql.exec(`INSERT INTO retired_vaults(vault_id,user_id) VALUES (?,?)`, retiredId.toString(), user.userId);
      release();
      release = undefined;
      await running;
      running = undefined;
      expect(state.storage.sql.exec(`SELECT user_id FROM users WHERE user_id=?`, user.userId).toArray()).toHaveLength(1);
      expect(state.storage.sql.exec(`SELECT vault_id FROM retired_vaults WHERE vault_id=?`, retiredId.toString()).toArray()).toHaveLength(1);
    } finally {
      release?.();
      await running;
      local.FILES = oldFiles;
      local.SWEEP_DELAY_MS = oldDelay;
    }
  });
}, 30_000);

it.each(["current", "retired"]) ("does not accept a changed %s sweep time after R2 yields", async (kind) => {
  const directory = env.DIRECTORY.getByName(`deletion-lanes-${crypto.randomUUID()}`);
  const user = await account(directory), retiredId = env.VAULT.newUniqueId();
  const retired = env.VAULT.get(retiredId);
  await retired.init(user.userId);
  await runInDurableObject(directory, async (instance, state) => {
    const local = (instance as unknown as { env: Env }).env;
    const oldDelay = local.SWEEP_DELAY_MS, oldFiles = local.FILES;
    local.SWEEP_DELAY_MS = "3600000";
    let running: Promise<void> | undefined;
    let release: (() => void) | undefined;
    try {
      if (kind === "retired") state.storage.sql.exec(`INSERT INTO retired_vaults(vault_id,user_id) VALUES (?,?)`, retiredId.toString(), user.userId);
      await instance.deleteAccount(user.userId, user.vaultId);
      await instance.alarm();
      local.SWEEP_DELAY_MS = "0";
      const id = kind === "retired" ? retiredId.toString() : user.vaultId;
      const held = heldListing(oldFiles, vaultPrefix(id));
      local.FILES = held.files;
      release = held.release;
      running = instance.alarm();
      await held.ready;
      const later = Date.now() + 60_000;
      if (kind === "retired") state.storage.sql.exec(`UPDATE retired_vaults SET swept_at=? WHERE vault_id=?`, later, id);
      else state.storage.sql.exec(`UPDATE vaults SET swept_at=? WHERE vault_id=?`, later, id);
      release(); release = undefined;
      await running; running = undefined;
      expect(state.storage.sql.exec(`SELECT user_id FROM users WHERE user_id=?`, user.userId).toArray()).toHaveLength(1);
      if (kind === "retired") {
        const row = state.storage.sql.exec<{state:string;swept_at:number}>(`SELECT state,swept_at FROM retired_vaults WHERE vault_id=?`, id).one();
        expect(row).toEqual({ state: "awaiting_final_sweep", swept_at: later });
      } else {
        expect(state.storage.sql.exec<{swept_at:number}>(`SELECT swept_at FROM vaults WHERE vault_id=?`, id).one().swept_at).toBe(later);
      }
    } finally {
      release?.(); await running;
      local.FILES = oldFiles; local.SWEEP_DELAY_MS = oldDelay;
    }
  });
}, 30_000);
