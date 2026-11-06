import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { directory, vault } from "../../src/shared/stubs";
import { fromBase64url } from "../../src/worker/crypto";
import { Vault } from "../../src/vault/vault";
import { Directory } from "../../src/directory/directory";
import { signIn } from "./support";

function session(cookie: string): { uid: string; vid: string; gen: number; epoch?: string } {
  const payload = cookie.slice("__Host-session=".length).split(".")[0]!;
  return JSON.parse(new TextDecoder().decode(fromBase64url(payload)));
}

describe("durable deletion intent", () => {
  it("rejects a session signed out before the deletion intent is recorded", async () => {
    const user = await signIn();
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const original = Vault.prototype.beginAccountDeletion;
    const spy = vi.spyOn(Vault.prototype, "beginAccountDeletion").mockImplementation(async function (this: Vault, who) {
      entered();
      await hold;
      return original.call(this, who);
    });
    let deletion: Promise<Response> | undefined;
    try {
      deletion = user.send("DELETE", "/auth/account");
      await ready;
      expect((await user.send("POST", "/api/account/sign-out-everywhere")).status).toBe(204);
      release();
      expect((await deletion).status).toBe(401);
      const again = await signIn(user.email);
      expect((await again.fetch("/api/me")).status).toBe(200);
    } finally {
      release();
      await deletion?.catch(() => {});
      spy.mockRestore();
    }
  }, 15_000);

  it("orders an accepted deletion before a concurrent sign-out", async () => {
    const user = await signIn();
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const original = Directory.prototype.deleteAccount;
    const spy = vi.spyOn(Directory.prototype, "deleteAccount").mockImplementation(async function (this: Directory, uid, vid) {
      entered();
      await hold;
      return original.call(this, uid, vid);
    });
    let deletion: Promise<Response> | undefined;
    try {
      deletion = user.send("DELETE", "/auth/account");
      await ready;
      expect((await user.send("POST", "/api/account/sign-out-everywhere")).status).toBe(410);
      release();
      expect((await deletion).status).toBe(202);
    } finally {
      release();
      await deletion?.catch(() => {});
      spy.mockRestore();
    }
  }, 15_000);

  it("keeps the same session able to retry deletion after Directory fails", async () => {
    const user = await signIn();
    const spy = vi.spyOn(Directory.prototype, "deleteAccount").mockRejectedValueOnce(new Error("synthetic unavailable"));
    try {
      expect((await user.send("DELETE", "/auth/account")).status).toBe(500);
      expect((await user.fetch("/api/me")).status).toBe(410);
      expect((await user.send("DELETE", "/auth/account")).status).toBe(202);
    } finally { spy.mockRestore(); }
  });

  it("does not let another identity or session generation resume a deletion intent", async () => {
    const user = await signIn();
    const s = session(user.cookie);
    const v = vault(env, s.vid);
    await v.beginAccountDeletion({ userId: s.uid, gen: s.gen, epoch: s.epoch });
    await runInDurableObject(v, async (instance) => {
      await expect(instance.beginAccountDeletion({ userId: "other", gen: s.gen, epoch: s.epoch })).rejects.toThrow("not this user's vault");
      await expect(instance.beginAccountDeletion({ userId: s.uid, gen: s.gen + 1, epoch: s.epoch })).rejects.toThrow("signed out");
      await expect(instance.beginAccountDeletion({ userId: s.uid, gen: s.gen, epoch: "different" })).rejects.toThrow("no longer valid");
    });
  });

  it("does not delete an account through a stale or missing vault ID", async () => {
    const user = await signIn();
    const s = session(user.cookie);
    const d = directory(env);
    const other = env.VAULT.newUniqueId().toString();
    await runInDurableObject(d, async (instance) => {
      await expect(instance.deleteAccount(s.uid, other)).rejects.toThrow("account vault has changed");
      await expect((instance.deleteAccount as (uid: string, vid?: string) => Promise<void>)(s.uid)).rejects.toThrow();
    });
    expect((await user.fetch("/api/me")).status).toBe(200);
  });

  it("rolls back the intent when its retry alarm cannot be installed", async () => {
    const user = await signIn();
    const s = session(user.cookie);
    const v = vault(env, s.vid);
    await runInDurableObject(v, async (instance, ctx) => {
      await ctx.storage.deleteAlarm();
      const fail = vi.spyOn(ctx.storage, "setAlarm").mockRejectedValueOnce(new Error("synthetic alarm failure"));
      try {
        await expect(instance.beginAccountDeletion({ userId: s.uid, gen: s.gen, epoch: s.epoch })).rejects.toThrow("synthetic alarm failure");
        expect(ctx.storage.sql.exec<{ value: string }>(`SELECT value FROM meta WHERE key='state'`).one().value).toBe("open");
        expect(ctx.storage.sql.exec(`SELECT value FROM meta WHERE key='account_deletion_intent'`).toArray()).toHaveLength(0);
      } finally { fail.mockRestore(); }
    });
    expect((await user.fetch("/api/me")).status).toBe(200);
  });

  it("preserves an already scheduled earlier alarm for deletion recovery", async () => {
    const user = await signIn();
    const s = session(user.cookie);
    const v = vault(env, s.vid);
    await runInDurableObject(v, async (instance, ctx) => {
      const earlier = Date.now() + 10_000;
      await ctx.storage.setAlarm(earlier);
      await instance.beginAccountDeletion({ userId: s.uid, gen: s.gen, epoch: s.epoch });
      expect(await ctx.storage.getAlarm()).toBe(earlier);
    });
  });

  it("retries through Directory when the Worker stops after the Vault intent", async () => {
    const user = await signIn();
    const s = session(user.cookie);
    const v = vault(env, s.vid);
    const d = directory(env);
    await runInDurableObject(d, (_instance, ctx) => {
      ctx.storage.sql.exec(`INSERT INTO vault_initializations (vault_id, sticky) VALUES (?, 1)`, s.vid);
    });
    await v.beginAccountDeletion({ userId: s.uid, gen: s.gen, epoch: s.epoch });
    expect((await user.fetch("/api/me")).status).toBe(410);
    expect(await runDurableObjectAlarm(v)).toBe(true);
    expect(await runInDurableObject(d, (_instance, ctx) =>
      ctx.storage.sql.exec<{ state: string }>(`SELECT state FROM vaults WHERE vault_id=?`, s.vid).one().state,
    )).toBe("deleting");
    expect(await d.hasVault(s.vid)).toBe(true);
  }, 15_000);

  it("keeps a retry alarm after a temporary Directory failure", async () => {
    const user = await signIn();
    const s = session(user.cookie);
    const v = vault(env, s.vid);
    const d = directory(env);
    await runInDurableObject(d, (_instance, ctx) => {
      ctx.storage.sql.exec(`INSERT INTO vault_initializations (vault_id, sticky) VALUES (?, 1)`, s.vid);
    });
    await v.beginAccountDeletion({ userId: s.uid, gen: s.gen, epoch: s.epoch });
    const failure = vi.spyOn(Directory.prototype, "deleteAccount").mockRejectedValueOnce(new Error("synthetic unavailable"));
    try {
      expect(await runDurableObjectAlarm(v)).toBe(true);
      expect(await runInDurableObject(v, (_instance, ctx) => ctx.storage.getAlarm())).toEqual(expect.any(Number));
    } finally { failure.mockRestore(); }
    expect(await runDurableObjectAlarm(v)).toBe(true);
    expect(await runInDurableObject(d, (_instance, ctx) =>
      ctx.storage.sql.exec<{ state: string }>(`SELECT state FROM vaults WHERE vault_id=?`, s.vid).one().state,
    )).toBe("deleting");
  }, 15_000);

  it("does not let an older workflow alarm overwrite the deletion retry", async () => {
    const user = await signIn();
    const s = session(user.cookie);
    const v = vault(env, s.vid);
    await runInDurableObject(v, async (instance, ctx) => {
      await ctx.storage.deleteAlarm();
      const oldTime = Date.now() + 3_600_000;
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const hold = new Promise<void>((resolve) => { release = resolve; });
      const realSet = ctx.storage.setAlarm.bind(ctx.storage);
      const spy = vi.spyOn(ctx.storage, "setAlarm").mockImplementation(async (at, opts) => {
        if (at === oldTime) { entered(); await hold; }
        return realSet(at, opts);
      });
      const internal = instance as unknown as { scheduleRunAlarm(at: number): Promise<void> };
      const prior = internal.scheduleRunAlarm(oldTime);
      try {
        await ready;
        await instance.beginAccountDeletion({ userId: s.uid, gen: s.gen, epoch: s.epoch });
        release();
        await prior;
        const alarm = await ctx.storage.getAlarm();
        expect(alarm).not.toBeNull();
        expect(alarm!).toBeLessThan(oldTime);
      } finally {
        release();
        await prior.catch(() => {});
        spy.mockRestore();
      }
    });
  }, 15_000);

  it("does not reinstall a deletion alarm after the Vault is destroyed", async () => {
    const user = await signIn();
    const s = session(user.cookie);
    const v = vault(env, s.vid);
    await runInDurableObject(v, async (instance, ctx) => {
      await instance.beginAccountDeletion({ userId: s.uid, gen: s.gen, epoch: s.epoch });
      await ctx.storage.deleteAlarm();
      let entered!: () => void, release!: () => void;
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const hold = new Promise<void>((resolve) => { release = resolve; });
      const realSet = ctx.storage.setAlarm.bind(ctx.storage);
      const spy = vi.spyOn(ctx.storage, "setAlarm").mockImplementation(async (at, opts) => {
        entered();
        await hold;
        return realSet(at, opts);
      });
      const internal = instance as unknown as { scheduleDeletionAlarm(at: number): Promise<void> };
      const pending = internal.scheduleDeletionAlarm(Date.now() + 60_000);
      try {
        await ready;
        await instance.destroy();
        release();
        await pending;
        expect(await ctx.storage.getAlarm()).toBeNull();
      } finally {
        release();
        await pending.catch(() => {});
        spy.mockRestore();
      }
    });
  }, 15_000);
});
