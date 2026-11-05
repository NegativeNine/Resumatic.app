import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { Vault } from "../../src/vault/vault";
import { directory, vault } from "../../src/shared/stubs";
import { uniqueEmail } from "./support";

/** The error an RPC call rejects with, as a string, or "ok". */
async function outcome(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    () => "ok",
    (e: unknown) => String(e),
  );
}

describe("vault lifecycle", () => {
  it("refuses every call before init, and init is safe to repeat", async () => {
    const v = vault(env, env.VAULT.newUniqueId().toString());
    const owner = { userId: "user-1", gen: 1 };
    expect(await outcome(v.me(owner))).toMatch(/gone: /);
    expect(await outcome(v.sourceText("any"))).toMatch(/gone: /);
    expect(await outcome(v.openSession("user-1"))).toMatch(/gone: /);

    await v.init("user-1");
    await v.init("user-1");
    expect((await v.me(owner)).userId).toBe("user-1");
    expect(await outcome(v.init("user-2"))).toMatch(/conflict: /);
    expect(await outcome(v.me({ userId: "user-2", gen: 1 }))).toMatch(/forbidden: /);
    expect(await outcome(v.me({ userId: "user-1", gen: 2 }))).toMatch(/unauthenticated: /);
  });

  it("stays empty and refuses calls once destroyed, even after it wakes again", async () => {
    const v = vault(env, env.VAULT.newUniqueId().toString());
    const owner = { userId: "user-1", gen: 1 };
    await v.init("user-1");
    await v.updateProfile(owner, { name: "Jane" });
    expect(await v.close()).toEqual({ distill: [], tailor: [] });
    expect(await outcome(v.me(owner))).toMatch(/gone: /);
    await v.destroy();
    await v.destroy();
    expect(await outcome(v.init("user-1"))).toMatch(/gone: /);

    await evictDurableObject(v);
    expect(await outcome(v.me(owner))).toMatch(/gone: /);
    expect(await v.close()).toEqual({ distill: [], tailor: [] });
  });
});

describe("Directory sign-in", () => {
  it("creates the vault on first sign-in only", async () => {
    const email = uniqueEmail();
    const input = { provider: "test" as const, subject: email, email, hint: "weur" as const };
    const init = vi.spyOn(Vault.prototype, "init");
    try {
      const first = await directory(env).signIn(input);
      expect(init).toHaveBeenCalledTimes(1);
      const again = await directory(env).signIn(input);
      expect(again).toEqual(first);
      expect(init).toHaveBeenCalledTimes(1);
    } finally {
      init.mockRestore();
    }
  });

  it("finishes creating a vault whose first init failed", async () => {
    const email = uniqueEmail();
    const input = { provider: "test" as const, subject: email, email, hint: "enam" as const };
    const init = vi.spyOn(Vault.prototype, "init").mockRejectedValueOnce(new Error("unavailable: simulated outage"));
    try {
      expect(await outcome(directory(env).signIn(input))).toMatch(/simulated outage/);
      const { vaultId, userId } = await directory(env).signIn(input);
      expect(init).toHaveBeenCalledTimes(2);
      expect((await vault(env, vaultId).openSession(userId)).gen).toBe(1);
      const state = await runInDurableObject(directory(env), (_instance, ctx) =>
        ctx.storage.sql.exec<{ state: string }>(`SELECT state FROM vaults WHERE vault_id = ?`, vaultId).one().state,
      );
      expect(state).toBe("active");
    } finally {
      init.mockRestore();
    }
  });
});
