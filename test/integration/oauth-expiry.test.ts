import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { directoryForSignIn } from "../../src/directory/routing";
import { directory } from "../../src/shared/stubs";
import { startSession } from "../../src/worker/routes";

const identity = () => {
  const id = crypto.randomUUID();
  return { provider: "google" as const, subject: `expiry-${id}`, email: `expiry-${id}@example.test`, hint: "enam" as const };
};

describe("OAuth expiry across Directory calls", () => {
  it("rejects an expired routed request before creating a claim or account", async () => {
    const p = identity();
    const global = directory(env);
    await global.addInvite(p.email);
    const expiry = Date.now() - 1;
    await runInDurableObject(global, async (instance, state) => {
      await expect(instance.claimIdentityHome(p.provider, p.subject, null, p.email, expiry)).rejects.toThrow("sign-in took too long");
      await expect(instance.signIn({ ...p, inviteAuthorized: true, authExpiryMs: expiry })).rejects.toThrow("sign-in took too long");
      expect(state.storage.sql.exec(`SELECT subject FROM identities WHERE provider=? AND subject=?`, p.provider, p.subject).toArray()).toHaveLength(0);
      expect(state.storage.sql.exec(`SELECT subject FROM identity_homes WHERE provider=? AND subject=?`, p.provider, p.subject).toArray()).toHaveLength(0);
    });
  });

  it("carries the signed expiry through routing to the destination", async () => {
    const p = identity();
    await directory(env).addInvite(p.email);
    const expiry = Date.now() + 60_000;
    const target = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "16" }, { ...p, authExpiryMs: expiry });
    expect(target.input.authExpiryMs).toBe(expiry);
    expect((await target.directory.signIn(target.input)).userId).toMatch(/^s(?:[0-9]|1[0-5]):/);
  });

  it("refuses a result when initialization outlives the signed state", async () => {
    const p = { ...identity(), provider: "test" as const };
    const stub = env.DIRECTORY.getByName(`expiry-init-${crypto.randomUUID()}`);
    await runInDurableObject(stub, async (instance) => {
      const local = (instance as unknown as { env: Env }).env;
      const original = local.VAULT;
      let release!: () => void;
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => { release = resolve; });
      const initialized = new Promise<void>((resolve) => { entered = resolve; });
      local.VAULT = {
        newUniqueId: () => original.newUniqueId(),
        idFromString: (value: string) => original.idFromString(value),
        get: (id: DurableObjectId, options: DurableObjectNamespaceGetDurableObjectOptions) => ({
          init: async (userId: string) => { entered(); await waiting; await original.get(id, options).init(userId); },
        }),
      } as unknown as typeof original;
      const pending = instance.signIn({ ...p, authExpiryMs: Date.now() + 1000 });
      try {
        await initialized;
        await new Promise((resolve) => setTimeout(resolve, 1200));
        release();
        await expect(pending).rejects.toThrow("sign-in took too long");
        // The account was created before expiry; a fresh sign-in can recover it.
        expect(await instance.existingIdentity(p.provider, p.subject)).not.toBeNull();
        expect((await instance.signIn({ ...p, authExpiryMs: Date.now() + 60_000 })).userId).toBeTruthy();
      } finally {
        release();
        await pending.catch(() => {});
        local.VAULT = original;
      }
    });
  }, 30_000);

  it("does not return a session cookie when openSession outlives state expiry", async () => {
    let now = Date.UTC(2026, 10, 1);
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const expires = now + 1000;
    const stub = {
      existingIdentity: async () => ({ userId: "synthetic-user", vaultId: "synthetic-vault" }),
      signIn: async () => ({ userId: "synthetic-user", vaultId: "synthetic-vault" }),
      bindIdentityHome: async () => {},
    };
    const openSession = vi.fn(async () => { now = expires; return { gen: 1, epoch: "synthetic" }; });
    const bindings = {
      SESSION_KEY: "synthetic-secret", DIRECTORY: { idFromName: (name: string) => name, get: () => stub },
      VAULT: { idFromString: (id: string) => id, get: () => ({ openSession }) },
    } as unknown as Env;
    try {
      await expect(startSession(bindings, { ...identity(), authExpiryMs: expires })).rejects.toThrow("sign-in took too long");
      expect(openSession).toHaveBeenCalledOnce();
    } finally {
      clock.mockRestore();
    }
  });
});
