import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { directory, vault } from "../../src/shared/stubs";
import { fromBase64url } from "../../src/worker/crypto";
import { signIn, uniqueEmail } from "./support";

function vaultId(cookie: string): string {
  const payload = cookie.slice("__Host-session=".length).split(".")[0]!;
  return JSON.parse(new TextDecoder().decode(fromBase64url(payload))).vid;
}

describe("deletion access revocation", () => {
  it("revokes copied sessions before acknowledging a deletion blocked by initialization", async () => {
    const user = await signIn();
    const vid = vaultId(user.cookie);
    await user.send("PUT", "/api/profile", { name: "Synthetic candidate" });
    const d = directory(env);
    await runInDurableObject(d, (_instance, ctx) => {
      ctx.storage.sql.exec(`INSERT INTO vault_initializations (vault_id, sticky) VALUES (?, 1)`, vid);
    });
    const response = await user.send("DELETE", "/auth/account");
    expect(response.status).toBe(202);
    expect((await user.fetch("/api/me")).status).toBe(410);
    await runDurableObjectAlarm(d);
    expect(await d.hasVault(vid)).toBe(true);
    const state = await runInDurableObject(d, (_instance, ctx) => ({
      marker: ctx.storage.sql.exec(`SELECT vault_id FROM vault_initializations WHERE vault_id=?`, vid).toArray().length,
      row: ctx.storage.sql.exec<{ state: string }>(`SELECT state FROM vaults WHERE vault_id=?`, vid).one().state,
    }));
    expect(state).toEqual({ marker: 1, row: "deleting" });
    expect((await user.fetch("/api/me")).status).toBe(410);
  });

  it("rolls back the deletion state when the first alarm cannot be scheduled", async () => {
    const d = env.DIRECTORY.getByName(`delete-alarm-${crypto.randomUUID()}`);
    const email = uniqueEmail();
    const account = await d.signIn({ provider: "test", subject: email, email, hint: "enam" });
    const v = vault(env, account.vaultId);
    const who = { userId: account.userId, gen: 1 };
    await runInDurableObject(d, async (instance, ctx) => {
      await ctx.storage.deleteAlarm();
      const fail = vi.spyOn(ctx.storage, "setAlarm").mockRejectedValueOnce(new Error("synthetic scheduling failure"));
      try {
        await expect(instance.deleteAccount(account.userId, account.vaultId)).rejects.toThrow("synthetic scheduling failure");
        expect(ctx.storage.sql.exec<{ state: string }>(`SELECT state FROM users WHERE user_id=?`, account.userId).one().state).toBe("active");
        expect(ctx.storage.sql.exec<{ state: string }>(`SELECT state FROM vaults WHERE vault_id=?`, account.vaultId).one().state).toBe("active");
        expect(await ctx.storage.getAlarm()).toBeNull();
      } finally { fail.mockRestore(); }
    });
    expect((await v.me(who)).userId).toBe(account.userId);
    await d.deleteAccount(account.userId, account.vaultId);
    expect(await v.me(who).then(() => "open", (error: unknown) => String(error))).toMatch(/gone:/);
    await runDurableObjectAlarm(d);
  });

  it("commits the real alarm and deleting state before a failed vault RPC", async () => {
    const d = env.DIRECTORY.getByName(`delete-quiesce-${crypto.randomUUID()}`);
    const email = uniqueEmail();
    const account = await d.signIn({ provider: "test", subject: email, email, hint: "enam" });
    const v = vault(env, account.vaultId);
    await runInDurableObject(d, async (instance, ctx) => {
      ctx.storage.sql.exec(`INSERT INTO vault_initializations (vault_id, sticky) VALUES (?, 1)`, account.vaultId);
      const local = (instance as unknown as { env: Env }).env;
      const original = local.VAULT;
      local.VAULT = {
        idFromString: (value: string) => original.idFromString(value),
        get: () => ({ quiesce: async () => { throw new Error("synthetic RPC failure"); } }),
      } as unknown as typeof original;
      try {
        await expect(instance.deleteAccount(account.userId, account.vaultId)).rejects.toThrow("synthetic RPC failure");
        expect(ctx.storage.sql.exec<{ state: string }>(`SELECT state FROM users WHERE user_id=?`, account.userId).one().state).toBe("deleting");
        expect(await ctx.storage.getAlarm()).not.toBeNull();
      } finally { local.VAULT = original; }
    });
    // The real alarm retries revocation and erasure after connectivity returns.
    const persisted = await runInDurableObject(d, async (_instance, ctx) => ({
      alarm: await ctx.storage.getAlarm(),
      state: ctx.storage.sql.exec<{ state: string }>(`SELECT state FROM users WHERE user_id=?`, account.userId).one().state,
    }));
    expect(persisted).toMatchObject({ state: "deleting", alarm: expect.any(Number) });
    expect(await runDurableObjectAlarm(d)).toBe(true);
    expect(await v.me({ userId: account.userId, gen: 1 }).then(() => "open", (error: unknown) => String(error))).toMatch(/gone:/);
    expect(await d.hasVault(account.vaultId)).toBe(true);
    expect(await runInDurableObject(d, (_instance, ctx) => ctx.storage.sql.exec(`SELECT vault_id FROM vault_initializations WHERE vault_id=?`, account.vaultId).toArray())).toHaveLength(1);
  });
});
