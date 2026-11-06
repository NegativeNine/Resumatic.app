import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { DIRECTORY_MIGRATIONS } from "../../src/directory/schema";
import { Vault } from "../../src/vault/vault";
import { uniqueEmail } from "./support";

const isolated = () => env.DIRECTORY.getByName(`init-fence-${crypto.randomUUID()}`);
const identity = () => {
  const email = uniqueEmail();
  return { provider: "test" as const, subject: email, email, hint: "enam" as const };
};

describe("Directory initialization fence", () => {
  it("coalesces concurrent first sign-ins while keeping the durable marker", async () => {
    const d = isolated();
    const input = identity();
    await runInDurableObject(d, async (instance, ctx) => {
      const local = (instance as unknown as { env: Env }).env;
      const original = local.VAULT;
      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const hold = new Promise<void>((resolve) => { release = resolve; });
      let calls = 0;
      local.VAULT = {
        newUniqueId: () => original.newUniqueId(),
        idFromString: (value: string) => original.idFromString(value),
        get: (id: DurableObjectId, options: DurableObjectNamespaceGetDurableObjectOptions) => ({
          init: async (userId: string) => { calls++; entered(); await hold; await original.get(id, options).init(userId); },
        }),
      } as unknown as typeof original;
      const first = instance.signIn(input);
      let second: typeof first | undefined;
      let third: typeof first | undefined;
      try {
        await ready;
        second = instance.signIn(input);
        third = instance.signIn(input);
        expect(calls).toBe(1);
        expect(ctx.storage.sql.exec(`SELECT vault_id FROM vault_initializations`).toArray()).toHaveLength(1);
        release();
        const results = await Promise.all([first, second, third]);
        expect(results[1]).toEqual(results[0]);
        expect(results[2]).toEqual(results[0]);
        expect(calls).toBe(1);
        expect(ctx.storage.sql.exec(`SELECT vault_id FROM vault_initializations`).toArray()).toHaveLength(0);
      } finally {
        release();
        await Promise.allSettled([first, ...(second ? [second] : []), ...(third ? [third] : [])]);
        local.VAULT = original;
      }
    });
  });

  it("coalesces an uncertain failure and keeps its fence when retried", async () => {
    const d = isolated();
    const input = identity();
    await runInDurableObject(d, async (instance, ctx) => {
      const local = (instance as unknown as { env: Env }).env;
      const original = local.VAULT;
      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const hold = new Promise<void>((resolve) => { release = resolve; });
      let calls = 0;
      local.VAULT = {
        newUniqueId: () => original.newUniqueId(),
        idFromString: (value: string) => original.idFromString(value),
        get: () => ({ init: async () => { calls++; entered(); await hold; throw new Error("synthetic uncertain init"); } }),
      } as unknown as typeof original;
      const first = instance.signIn(input).then(() => "ok", (error: unknown) => String(error));
      let second: Promise<string> | undefined;
      try {
        await ready;
        second = instance.signIn(input).then(() => "ok", (error: unknown) => String(error));
        expect(calls).toBe(1);
        release();
        expect(await first).toMatch(/synthetic uncertain init/);
        expect(await second).toMatch(/synthetic uncertain init/);
        expect(await instance.signIn(input).then(() => "ok", (error: unknown) => String(error))).toMatch(/synthetic uncertain init/);
        expect(calls).toBe(2);
        expect(ctx.storage.sql.exec<{sticky: number}>(`SELECT sticky FROM vault_initializations`).one().sticky).toBe(1);
      } finally {
        release();
        await first;
        if (second) await second;
        local.VAULT = original;
      }
    });
  });

  it("does not clear a marker made sticky while an earlier acknowledgement is pending", async () => {
    const d = isolated();
    const input = identity();
    await runInDurableObject(d, async (instance, ctx) => {
      const local = (instance as unknown as { env: Env }).env;
      const original = local.VAULT;
      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const hold = new Promise<void>((resolve) => { release = resolve; });
      local.VAULT = {
        newUniqueId: () => original.newUniqueId(),
        idFromString: (value: string) => original.idFromString(value),
        get: (id: DurableObjectId, options: DurableObjectNamespaceGetDurableObjectOptions) => ({
          init: async (userId: string) => { entered(); await hold; await original.get(id, options).init(userId); },
        }),
      } as unknown as typeof original;
      const pending = instance.signIn(input);
      try {
        await ready;
        const row = ctx.storage.sql.exec<{user_id: string; vault_id: string}>(`SELECT user_id,vault_id FROM vaults`).one();
        ctx.storage.sql.exec(`UPDATE vault_initializations SET sticky=1 WHERE vault_id=?`, row.vault_id);
        // A deployed older Directory version may issue the former unconditional
        // DELETE after its init acknowledgement. The database fence must win.
        ctx.storage.sql.exec(`DELETE FROM vault_initializations WHERE vault_id=?`, row.vault_id);
        expect(ctx.storage.sql.exec<{sticky: number}>(`SELECT sticky FROM vault_initializations WHERE vault_id=?`, row.vault_id).one().sticky).toBe(1);
        local.VAULT = original;
        release();
        expect(await pending).toEqual({ userId: row.user_id, vaultId: row.vault_id });
        expect(ctx.storage.sql.exec<{sticky: number}>(`SELECT sticky FROM vault_initializations WHERE vault_id=?`, row.vault_id).one().sticky).toBe(1);
        await instance.deleteAccount(row.user_id, row.vault_id);
        await instance.alarm();
        expect(await instance.hasVault(row.vault_id)).toBe(true);
      } finally {
        release();
        await pending.catch(() => {});
        local.VAULT = original;
      }
    });
  });

  it("keeps deletion pending until in-flight sign-in init is acknowledged and does not return a deleting account", async () => {
    const d = isolated();
    const input = identity();
    await runInDurableObject(d, async (instance, ctx) => {
      const local = (instance as unknown as { env: Env }).env;
      const original = local.VAULT;
      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const hold = new Promise<void>((resolve) => { release = resolve; });
      local.VAULT = {
        newUniqueId: () => original.newUniqueId(),
        idFromString: (value: string) => original.idFromString(value),
        get: (id: DurableObjectId, options: DurableObjectNamespaceGetDurableObjectOptions) => ({
          init: async (userId: string) => { entered(); await hold; await original.get(id, options).init(userId); },
        }),
      } as unknown as typeof original;
      const attempt = instance.signIn(input).then(() => "ok", (error: unknown) => String(error));
      let concurrent: Promise<string> | undefined;
      try {
        await ready;
        concurrent = instance.signIn(input).then(() => "ok", (error: unknown) => String(error));
        local.VAULT = original;
        const row = ctx.storage.sql.exec<{user_id: string; vault_id: string}>(`SELECT user_id,vault_id FROM vaults`).one();
        await instance.deleteAccount(row.user_id, row.vault_id);
        await instance.alarm();
        expect(await instance.hasVault(row.vault_id)).toBe(true);
        expect(ctx.storage.sql.exec(`SELECT vault_id FROM vault_initializations WHERE vault_id=?`, row.vault_id).toArray()).toHaveLength(1);
        release();
        expect(await attempt).toMatch(/account is being deleted/);
        expect(await concurrent).toMatch(/account is being deleted/);
        await instance.alarm();
        await instance.alarm();
        expect(await instance.hasVault(row.vault_id)).toBe(false);
      } finally {
        release();
        await attempt;
        if (concurrent) await concurrent;
        local.VAULT = original;
      }
    });
  });

  it("recovers sign-in after a lost init acknowledgement without clearing the deletion fence", async () => {
    const d = isolated();
    const input = identity();
    const original = Vault.prototype.init;
    const spy = vi.spyOn(Vault.prototype, "init").mockImplementationOnce(async function (this: Vault, userId) {
      await original.call(this, userId);
      throw new Error("synthetic lost initialization acknowledgement");
    });
    try {
      expect(await d.signIn(input).then(() => "ok", (error: unknown) => String(error))).toMatch(/synthetic lost/);
      const row = await runInDurableObject(d, (_instance, ctx) => ctx.storage.sql.exec<{user_id: string; vault_id: string}>(`SELECT user_id,vault_id FROM vaults`).one());
      await evictDurableObject(d);
      await runInDurableObject(d, async (instance, ctx) => {
        const internal = instance as unknown as { initializeVault(vaultId: string, userId: string): Promise<void> };
        await expect(internal.initializeVault(row.vault_id, "another-owner")).rejects.toThrow(/identity changed/);
        expect(ctx.storage.sql.exec<{sticky: number}>(`SELECT sticky FROM vault_initializations WHERE vault_id=?`, row.vault_id).one().sticky).toBe(0);
      });
      const recovered = await d.signIn(input);
      expect(recovered).toEqual({ userId: row.user_id, vaultId: row.vault_id });
      expect(spy).toHaveBeenCalledTimes(2);
      expect(await runInDurableObject(d, (_instance, ctx) => ctx.storage.sql.exec<{sticky: number}>(`SELECT sticky FROM vault_initializations WHERE vault_id=?`, row.vault_id).one().sticky)).toBe(1);
      await d.deleteAccount(row.user_id, row.vault_id);
      await runDurableObjectAlarm(d);
      expect(await d.hasVault(row.vault_id)).toBe(true);
      expect(await runInDurableObject(d, (_instance, ctx) => ctx.storage.sql.exec(`SELECT vault_id FROM vault_initializations WHERE vault_id=?`, row.vault_id).toArray())).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("coalesces recovery attempts and keeps deletion pending even after their acknowledgement", async () => {
    const d = isolated();
    const input = identity();
    const realInit = Vault.prototype.init;
    const spy = vi.spyOn(Vault.prototype, "init").mockRejectedValueOnce(new Error("synthetic unknown init"));
    try {
      expect(await d.signIn(input).then(() => "ok", (error: unknown) => String(error))).toMatch(/synthetic unknown init/);
      await runInDurableObject(d, async (instance, ctx) => {
        const local = (instance as unknown as { env: Env }).env;
        const original = local.VAULT;
        let entered!: () => void;
        let release!: () => void;
        const ready = new Promise<void>((resolve) => { entered = resolve; });
        const hold = new Promise<void>((resolve) => { release = resolve; });
        let calls = 0;
        local.VAULT = {
          newUniqueId: () => original.newUniqueId(),
          idFromString: (value: string) => original.idFromString(value),
          get: (id: DurableObjectId, options: DurableObjectNamespaceGetDurableObjectOptions) => ({
            init: async (userId: string) => { calls++; entered(); await hold; await original.get(id, options).init(userId); },
          }),
        } as unknown as typeof original;
        const first = instance.signIn(input).then(() => "ok", (error: unknown) => String(error));
        let second: Promise<string> | undefined;
        try {
          await ready;
          second = instance.signIn(input).then(() => "ok", (error: unknown) => String(error));
          const row = ctx.storage.sql.exec<{user_id: string; vault_id: string}>(`SELECT user_id,vault_id FROM vaults`).one();
          expect(ctx.storage.sql.exec<{sticky: number}>(`SELECT sticky FROM vault_initializations WHERE vault_id=?`, row.vault_id).one().sticky).toBe(1);
          expect(calls).toBe(1);
          const internals = instance as unknown as { initializeVault(vaultId: string, userId: string): Promise<void> };
          await expect(internals.initializeVault(row.vault_id, "another-owner")).rejects.toThrow(/owner changed/);
          local.VAULT = original;
          await instance.deleteAccount(row.user_id, row.vault_id);
          await instance.alarm();
          expect(await instance.hasVault(row.vault_id)).toBe(true);
          release();
          expect(await first).toMatch(/account is being deleted/);
          expect(await second).toMatch(/account is being deleted/);
          await instance.alarm();
          expect(await instance.hasVault(row.vault_id)).toBe(true);
          expect(ctx.storage.sql.exec<{sticky: number}>(`SELECT sticky FROM vault_initializations WHERE vault_id=?`, row.vault_id).one().sticky).toBe(1);
        } finally {
          release();
          await first;
          if (second) await second;
          local.VAULT = original;
        }
      });
    } finally {
      spy.mockRestore();
      expect(Vault.prototype.init).toBe(realInit);
    }
  });

  it("recovers replacement initialization with its original immutable target and a persistent fence", async () => {
    const d = isolated();
    const { vaultId, userId } = await d.signIn(identity());
    const operation = crypto.randomUUID();
    const original = Vault.prototype.init;
    const spy = vi.spyOn(Vault.prototype, "init").mockImplementationOnce(async function (this: Vault, owner) {
      await original.call(this, owner);
      throw new Error("synthetic replacement acknowledgement lost");
    });
    try {
      expect(await d.prepareReplacement(vaultId, operation).then(() => "ok", (error: unknown) => String(error))).toMatch(/acknowledgement lost/);
      const target = await runInDurableObject(d, (_instance, ctx) => ctx.storage.sql.exec<{target_id: string}>(`SELECT target_id FROM vault_replacements WHERE operation_id=?`, operation).one().target_id);
      await evictDurableObject(d);
      expect(await d.prepareReplacement(vaultId, operation)).toEqual({ targetVaultId: target });
      expect(await runInDurableObject(d, (_instance, ctx) => ctx.storage.sql.exec<{sticky: number}>(`SELECT sticky FROM vault_initializations WHERE vault_id=?`, target).one().sticky)).toBe(1);
      await d.deleteAccount(userId, vaultId);
      await runDurableObjectAlarm(d);
      expect(await d.hasVault(target)).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("fences replacement init while account deletion retires its target", async () => {
    const d = isolated();
    const { vaultId, userId } = await d.signIn(identity());
    await runInDurableObject(d, async (instance, ctx) => {
      const local = (instance as unknown as { env: Env }).env;
      const original = local.VAULT;
      let entered!: () => void;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const hold = new Promise<void>((resolve) => { release = resolve; });
      local.VAULT = {
        newUniqueId: () => original.newUniqueId(),
        idFromString: (value: string) => original.idFromString(value),
        get: (id: DurableObjectId, options: DurableObjectNamespaceGetDurableObjectOptions) => ({
          init: async (idUser: string) => { entered(); await hold; await original.get(id, options).init(idUser); },
        }),
      } as unknown as typeof original;
      const operation = crypto.randomUUID();
      const pending = instance.prepareReplacement(vaultId, operation).then(() => "ok", (error: unknown) => String(error));
      try {
        await ready;
        local.VAULT = original;
        const targetId = ctx.storage.sql.exec<{target_id: string}>(`SELECT target_id FROM vault_replacements WHERE operation_id=?`, operation).one().target_id;
        await expect(instance.deleteAccount(userId, vaultId)).rejects.toThrow(/retired vault ownership requires review/);
        await instance.alarm();
        expect(await instance.hasVault(targetId)).toBe(true);
        release();
        expect(await pending).toMatch(/no longer active/);
        await instance.alarm();
        await instance.alarm();
        await instance.alarm();
        expect(await instance.hasVault(targetId)).toBe(false);
      } finally {
        release();
        await pending;
        local.VAULT = original;
      }
    });
  });

  it("marks historical active, replacement and retired IDs during migration", async () => {
    const d = isolated();
    const { vaultId, userId } = await d.signIn(identity());
    const target = env.VAULT.newUniqueId().toString();
    const retired = env.VAULT.newUniqueId().toString();
    await runInDurableObject(d, (_instance, ctx) => {
      ctx.storage.sql.exec(`ALTER TABLE retired_vaults DROP COLUMN generation`);
      for (const trigger of ["billing_account_insert_token", "billing_account_update_token", "billing_account_delete_token"])
        ctx.storage.sql.exec(`DROP TRIGGER ${trigger}`);
      ctx.storage.sql.exec(`DROP TABLE billing_state_clock`);
      ctx.storage.sql.exec(`ALTER TABLE billing_accounts DROP COLUMN state_token`);
      ctx.storage.sql.exec(`ALTER TABLE billing_events DROP COLUMN incarnation`);
      ctx.storage.sql.exec(`DROP TRIGGER guard_shard_home_claim_bind`);
      ctx.storage.sql.exec(`DROP TRIGGER remove_shard_home_claim_token`);
      ctx.storage.sql.exec(`DROP TRIGGER remove_shard_identity_claim_on_identity`);
      ctx.storage.sql.exec(`DROP TRIGGER remove_shard_identity_claim_token`);
      ctx.storage.sql.exec(`DROP TABLE shard_home_claim_tokens`);
      ctx.storage.sql.exec(`DROP TABLE shard_identity_claim_tokens`);
      ctx.storage.sql.exec(`DROP TABLE shard_home_bind_claim_marker`);
      ctx.storage.sql.exec(`DROP TABLE shard_rollout_barrier`);
      ctx.storage.sql.exec(`DELETE FROM meta WHERE key='shard_rollout_epoch'`);
      for (const trigger of ["guard_shard_google_insert_v3", "guard_shard_google_delete_v3", "guard_global_google_release_v3"]) ctx.storage.sql.exec(`DROP TRIGGER ${trigger}`);
      for (const table of ["shard_auth_marker", "shard_google_delete_v3_marker", "global_google_release_v3_marker"]) ctx.storage.sql.exec(`DROP TABLE ${table}`);
      ctx.storage.sql.exec(`ALTER TABLE shard_deletion_releases DROP COLUMN fence_epoch`);
      ctx.storage.sql.exec(`DELETE FROM meta WHERE key IN ('shard_auth_floor','shard_auth_floor_guard','global_shard_release_v3_guard')`);
      ctx.storage.sql.exec(`DROP TABLE billing_delivery_retries`);
      ctx.storage.sql.exec(`DROP INDEX billing_pending_by_time`);
      ctx.storage.sql.exec(`ALTER TABLE billing_events DROP COLUMN next_attempt_at`);
      for (const trigger of ["guard_shard_google_identity_delete", "guard_global_google_shard_home_delete"]) ctx.storage.sql.exec(`DROP TRIGGER ${trigger}`);
      for (const table of ["shard_deletion_releases", "shard_identity_delete_marker", "global_shard_home_release_marker"]) ctx.storage.sql.exec(`DROP TABLE ${table}`);
      ctx.storage.sql.exec(`DELETE FROM meta WHERE key='shard_deletion_guard'`);
      for (const trigger of ["global_auth_delete_epoch", "global_auth_identity_insert", "global_auth_identity_delete", "global_auth_home_insert", "global_auth_home_bind"]) ctx.storage.sql.exec(`DROP TRIGGER ${trigger}`);
      ctx.storage.sql.exec(`DROP TABLE global_auth_marker`);
      ctx.storage.sql.exec(`INSERT INTO vault_replacements (operation_id,source_id,target_id,user_id,state) VALUES (?,?,?,?, 'complete')`, crypto.randomUUID(), vaultId, target, userId);
      ctx.storage.sql.exec(`INSERT INTO retired_vaults (vault_id,user_id) VALUES (?,?)`, retired, userId);
      for (const table of ["placement_attempts", "placement_receipts", "placement_identities", "placement_finalizations", "placement_releases"]) ctx.storage.sql.exec(`DROP TABLE ${table}`);
      ctx.storage.sql.exec(`ALTER TABLE identity_homes DROP COLUMN generation`);
      ctx.storage.sql.exec(`ALTER TABLE identity_homes DROP COLUMN placement_state`);
      ctx.storage.sql.exec(`DROP TABLE vault_initializations`);
      ctx.storage.sql.exec(`ALTER TABLE vaults DROP COLUMN stripe_checkout_sessions`);
      const previous = DIRECTORY_MIGRATIONS.findIndex((migration) => migration.some((statement) => statement.includes("CREATE TABLE vault_initializations")));
      expect(previous).toBeGreaterThan(0);
      ctx.storage.sql.exec(`UPDATE meta SET value=? WHERE key='schema_version'`, String(previous));
    });
    await evictDurableObject(d);
    const marked = await runInDurableObject(d, (_instance, ctx) => ctx.storage.sql.exec<{vault_id: string; sticky: number}>(`SELECT vault_id,sticky FROM vault_initializations`).toArray());
    expect(marked.map((row) => row.vault_id).sort()).toEqual([vaultId, target, retired].sort());
    expect(marked.every((row) => row.sticky === 1)).toBe(true);
    await d.deleteAccount(userId, vaultId);
    await runDurableObjectAlarm(d);
    expect(await d.hasVault(vaultId)).toBe(true);
  });
});
