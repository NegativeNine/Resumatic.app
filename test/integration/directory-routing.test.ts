import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { directoryForSignIn } from "../../src/directory/routing";
import type { Directory } from "../../src/directory/directory";
import {
  allDirectories,
  directory,
  directoryForUser,
} from "../../src/shared/stubs";
import type { SignInInput } from "../../src/shared/types";
import { startSession } from "../../src/worker/routes";
import { eventually } from "./support";

async function input(): Promise<SignInInput> {
  const id = crypto.randomUUID();
  return {
    provider: "google",
    subject: `subject-${id}`,
    email: `shard-${id}@example.test`,
    hint: "enam",
    authEpoch: await directory(env).googleAuthEpoch(),
  };
}
const configured = (shards: string): Env => ({
  ...env,
  DIRECTORY_SHARDS: shards,
});

describe("Directory placement in Durable Objects", () => {
  it("preserves legacy accounts and keeps newly sharded accounts reachable after disabling creation", async () => {
    const legacyInput = await input();
    await directory(env).addInvite(legacyInput.email);
    const legacy = await directory(env).signIn(legacyInput);
    const legacyTarget = await directoryForSignIn(
      configured("16"),
      legacyInput,
    );
    expect(await legacyTarget.directory.signIn(legacyTarget.input)).toEqual(
      legacy,
    );

    const shardInput = await input();
    await directory(env).addInvite(shardInput.email);
    const target = await directoryForSignIn(configured("16"), shardInput);
    const created = await target.directory.signIn(target.input);
    expect(created.userId).toMatch(/^s(?:[0-9]|1[0-5]):/);
    expect(
      await directory(env).existingIdentity(
        shardInput.provider,
        shardInput.subject,
      ),
    ).toBeNull();
    const disabled = await directoryForSignIn(configured("1"), shardInput);
    expect(await disabled.directory.signIn(disabled.input)).toEqual(created);
    expect(
      await directoryForUser(env, created.userId).existingIdentity(
        shardInput.provider,
        shardInput.subject,
      ),
    ).toEqual(created);
  });

  it("creates exactly one account under overlapping shard configurations", async () => {
    const p = await input();
    await directory(env).addInvite(p.email);
    const choices = await Promise.all([
      directoryForSignIn(configured("16"), p),
      directoryForSignIn(configured("1"), p),
    ]);
    const accounts = await Promise.all(
      choices.map((choice) => choice.directory.signIn(choice.input)),
    );
    expect(accounts[0]).toEqual(accounts[1]);
    const locations = await Promise.all(
      [...allDirectories(env)].map((home) =>
        home.existingIdentity(p.provider, p.subject),
      ),
    );
    expect(locations.filter(Boolean)).toEqual([accounts[0]]);
  });

  it("erases the central placement claim when a sharded account is deleted", async () => {
    const p = await input();
    await directory(env).addInvite(p.email);
    const target = await directoryForSignIn(configured("16"), p);
    const account = await target.directory.signIn(target.input);
    await directory(env).bindIdentityHome(p.provider, p.subject, account.userId, p.authEpoch);
    const home = directoryForUser(env, account.userId);
    await home.deleteAccount(account.userId, account.vaultId);
    await runDurableObjectAlarm(home);
    await eventually(
      async () => (await home.existingIdentity(p.provider, p.subject)) === null,
      "sharded account erasure",
    );
    const claims = await runInDurableObject(
      directory(env),
      (_instance, state) =>
        state.storage.sql
          .exec(
            `SELECT * FROM identity_homes WHERE provider = ? AND subject = ?`,
            p.provider,
            p.subject,
          )
          .toArray(),
    );
    expect(claims).toEqual([]);
  });

  it.each([["16", "1"], ["1", "16"]])(
    "does not recreate a deleted account on a stale %s-shard route after placement changes to %s",
    async (oldPlacement, newPlacement) => {
      const p = await input();
      await directory(env).addInvite(p.email);
      const initial = await directoryForSignIn(configured(oldPlacement), p);
      const old = await initial.directory.signIn(initial.input);
      await directory(env).bindIdentityHome(p.provider, p.subject, old.userId, p.authEpoch);
      // This routing result can be held by an in-flight sign-in while the
      // account is erased and an independently routed sign-in creates another.
      const stale = await directoryForSignIn(configured(oldPlacement), p);
      expect(stale.input.expectedUserId).toBe(old.userId);
      const home = directoryForUser(env, old.userId);
      await home.deleteAccount(old.userId, old.vaultId);
      await runDurableObjectAlarm(home);
      await eventually(
        async () => (await home.existingIdentity(p.provider, p.subject)) === null,
        "old identity erasure",
      );
      await directory(env).addInvite(p.email);
      const freshInput = { ...p, authEpoch: await directory(env).googleAuthEpoch() };
      const fresh = await directoryForSignIn(configured(newPlacement), freshInput);
      const replacement = await fresh.directory.signIn(fresh.input);
      await directory(env).bindIdentityHome(p.provider, p.subject, replacement.userId, freshInput.authEpoch);
      expect(replacement.userId).not.toBe(old.userId);
      await runInDurableObject(stale.directory, async (instance) => {
        await expect((instance as Directory).signIn(stale.input)).rejects.toThrow(/account changed|sign-in is stale/);
      });
      const locations = await Promise.all(
        [...allDirectories(env)].map((d) => d.existingIdentity(p.provider, p.subject)),
      );
      expect(locations.filter(Boolean)).toEqual([replacement]);
    },
    30_000,
  );

  it("does not let a delayed deletion or bind overwrite a newer placement on the same shard", async () => {
    const p = await input();
    const global = directory(env);
    const shard = 3;
    const oldUser = `s${shard}:${crypto.randomUUID()}`;
    const newUser = `s${shard}:${crypto.randomUUID()}`;
    await global.addInvite(p.email);
    await global.claimIdentityHome(p.provider, p.subject, shard, p.email, undefined, p.authEpoch);
    await global.bindIdentityHome(p.provider, p.subject, oldUser, p.authEpoch);
    await runInDurableObject(global, async (instance) => {
      await expect((instance as Directory).forgetIdentityHome(p.provider, p.subject, shard, oldUser)).rejects.toThrow("account placement requires review");
    });
    await global.forgetGoogleShardHomeV3(p.subject, shard, oldUser);
    const freshEpoch = await global.googleAuthEpoch();
    await global.claimIdentityHome(p.provider, p.subject, shard, p.email, undefined, freshEpoch);
    // An unbound new claim cannot safely be identified as the deleted user.
    await runInDurableObject(global, async (instance) => {
      await expect((instance as Directory).forgetIdentityHome(p.provider, p.subject, shard, oldUser)).rejects.toThrow("placement requires review");
    });
    await global.bindIdentityHome(p.provider, p.subject, newUser, freshEpoch);
    await runInDurableObject(global, async (instance) => {
      await expect((instance as Directory).forgetIdentityHome(p.provider, p.subject, shard, oldUser)).rejects.toThrow("account placement requires review");
    });
    await runInDurableObject(global, async (instance) => {
      await expect((instance as Directory).bindIdentityHome(p.provider, p.subject, oldUser, freshEpoch)).rejects.toThrow("placement changed");
      await expect((instance as Directory).forgetIdentityHome(p.provider, p.subject, shard + 1, newUser)).rejects.toThrow("placement requires review");
    });
    const rows = await runInDurableObject(global, (_instance, state) => state.storage.sql
      .exec<{ shard: number; user_id: string }>(`SELECT shard,user_id FROM identity_homes WHERE provider=? AND subject=?`, p.provider, p.subject).toArray());
    expect(rows).toEqual([{ shard, user_id: newUser }]);
    // Calls in flight from an older Worker cannot perform an unqualified delete.
    await runInDurableObject(global, async (instance) => {
      await expect(((instance as Directory).forgetIdentityHome as unknown as (...args: unknown[]) => Promise<void>).call(instance, p.provider, p.subject, shard)).rejects.toThrow("placement requires review");
    });
  });

  it("preserves legacy global accounts but rejects missing sharded homes", async () => {
    const p = await input();
    const global = directory(env);
    await expect(global.bindIdentityHome(p.provider, p.subject, crypto.randomUUID(), p.authEpoch)).resolves.toBeUndefined();
    await runInDurableObject(global, async (instance) => {
      const uuid = crypto.randomUUID();
      for (const userId of [`s3:${uuid}`, `s03:${uuid}`, `S3:${uuid}`])
        await expect((instance as Directory).bindIdentityHome(p.provider, p.subject, userId, p.authEpoch)).rejects.toThrow("sharded account placement requires review");
      for (const userId of [`s16:${uuid}`, `s-1:${uuid}`, "s3:existing"])
        await expect((instance as Directory).bindIdentityHome(p.provider, p.subject, userId, p.authEpoch)).rejects.toThrow("invalid account home shard");
    });
  });

  it("issues sessions for a legacy global account with no home row", async () => {
    const p = await input();
    const global = directory(env);
    await global.addInvite(p.email);
    const account = await global.signIn(p);
    const homes = await runInDurableObject(global, (_instance, state) => state.storage.sql
      .exec(`SELECT shard FROM identity_homes WHERE provider=? AND subject=?`, p.provider, p.subject).toArray());
    expect(homes).toEqual([]);
    expect(account.userId).not.toContain(":");
    expect(await startSession(configured("16"), p)).toContain("__Host-session=");
  });

  it("does not issue a new session to a sharded identity after its home was released", async () => {
    const p = await input();
    const global = directory(env);
    await global.addInvite(p.email);
    const target = await directoryForSignIn(configured("16"), p);
    const account = await target.directory.signIn(target.input);
    await global.bindIdentityHome(p.provider, p.subject, account.userId, p.authEpoch);
    const shard = Number(account.userId.match(/^s(\d+):/)![1]);
    expect(await startSession(configured("16"), p)).toContain("__Host-session=");
    const repeated = await Promise.all([startSession(configured("16"), p), startSession(configured("16"), p)]);
    expect(repeated.every((cookie) => cookie.includes("__Host-session="))).toBe(true);
    // Model a released coordinator home while the shard still contains its
    // identity; a new authorization must not silently revive the orphan.
    await global.forgetGoogleShardHomeV3(p.subject, shard, account.userId);
    const fresh = { ...p, authEpoch: await global.googleAuthEpoch() };
    await expect(startSession(configured("16"), fresh)).rejects.toThrow("sharded account placement requires review");
    expect(await directoryForUser(env, account.userId).existingIdentity(p.provider, p.subject)).toEqual(account);
    const homes = await runInDurableObject(global, (_instance, state) => state.storage.sql
      .exec(`SELECT shard FROM identity_homes WHERE provider=? AND subject=?`, p.provider, p.subject).toArray());
    expect(homes).toEqual([]);
    // A new, unbound claim cannot prove ownership of the surviving row.
    await global.claimIdentityHome(p.provider, p.subject, shard, p.email, undefined, fresh.authEpoch);
    await expect(startSession(configured("16"), fresh)).rejects.toThrow("sharded account placement requires review");
    const unbound = await runInDurableObject(global, (_instance, state) => state.storage.sql
      .exec<{ user_id: string | null }>(`SELECT user_id FROM identity_homes WHERE provider=? AND subject=?`, p.provider, p.subject).one());
    expect(unbound.user_id).toBeNull();
  });

  it("allows overlapping first sign-ins to establish one new sharded account", async () => {
    const p = await input();
    const global = directory(env);
    await global.addInvite(p.email);
    const results = await Promise.allSettled([startSession(configured("16"), p), startSession(configured("16"), p)]);
    expect(results.some((result) => result.status === "fulfilled" && result.value.includes("__Host-session="))).toBe(true);
    for (const result of results) if (result.status === "rejected")
      expect(String(result.reason)).toContain("sharded account placement requires review");
    expect(await startSession(configured("16"), p)).toContain("__Host-session=");
    const locations = await Promise.all([...allDirectories(env)].map((d) => d.existingIdentity(p.provider, p.subject)));
    expect(locations.filter(Boolean)).toHaveLength(1);
  });

  it("distinguishes the RPC that inserted a shard identity from a later discovery", async () => {
    const p = await input();
    const global = directory(env);
    await global.addInvite(p.email);
    // Both routing decisions are made before either target identity exists.
    const first = await directoryForSignIn(configured("16"), p);
    const late = await directoryForSignIn(configured("16"), p);
    expect(late.input.expectedUserId).toBeUndefined();
    const inserted = await first.directory.signIn({ ...first.input, reportCreation: true });
    const discovered = await late.directory.signIn({ ...late.input, reportCreation: true });
    expect(inserted).toMatchObject({ created: true });
    expect(discovered).toEqual({ ...inserted, created: false });
    await runInDurableObject(global, async (instance) => {
      await expect((instance as Directory).bindIdentityHome(p.provider, p.subject, discovered.userId, p.authEpoch, undefined, true))
        .rejects.toThrow("sharded account placement requires review");
    });
    await global.bindIdentityHome(p.provider, p.subject, inserted.userId, p.authEpoch);
    await expect(global.bindIdentityHome(p.provider, p.subject, discovered.userId, p.authEpoch, undefined, true)).resolves.toBeUndefined();
  });

  it("rejects a delayed creator's old authorization after its home is released and reclaimed", async () => {
    const p = await input();
    const global = directory(env);
    await global.addInvite(p.email);
    const target = await directoryForSignIn(configured("16"), p);
    const account = await target.directory.signIn({ ...target.input, reportCreation: true });
    expect(account.created).toBe(true);
    await global.bindIdentityHome(p.provider, p.subject, account.userId, p.authEpoch);
    const shard = target.input.homeShard!;
    await global.forgetGoogleShardHomeV3(p.subject, shard, account.userId);
    const epoch = await global.googleAuthEpoch();
    await global.claimIdentityHome(p.provider, p.subject, shard, p.email, undefined, epoch);
    await runInDurableObject(global, async (instance) => {
      await expect((instance as Directory).bindIdentityHome(p.provider, p.subject, account.userId, p.authEpoch))
        .rejects.toThrow("sign-in is stale");
    });
    const home = await runInDurableObject(global, (_instance, state) => state.storage.sql
      .exec<{ user_id: string | null }>(`SELECT user_id FROM identity_homes WHERE provider=? AND subject=?`, p.provider, p.subject).one());
    expect(home.user_id).toBeNull();
  });

  it("requires a bound home for late-discovered or old-runtime shard results", async () => {
    for (const reported of [false, undefined, "true"] as const) {
      const p = await input();
      const bind = vi.fn(async (...args: unknown[]) => {
        if (args[5] === true) throw new Error("unbound home blocked");
      });
      const global = {
        existingIdentity: async () => null,
        requireInvite: async () => {},
        claimIdentityHome: async (_provider: string, _subject: string, shard: number) => shard,
        bindIdentityHome: bind,
      };
      const shard = {
        existingIdentity: async () => null,
        signIn: async () => ({ userId: `s1:${crypto.randomUUID()}`, vaultId: "synthetic-vault", created: reported }),
      };
      const openSession = vi.fn(async () => ({ gen: 1, epoch: "synthetic" }));
      const bindings = {
        SESSION_KEY: "synthetic-secret", DIRECTORY_SHARDS: "16",
        DIRECTORY: { idFromName: (name: string) => name, get: (name: string) => name === "global" ? global : shard },
        VAULT: { idFromString: (id: string) => id, get: () => ({ openSession }) },
      } as unknown as Env;
      await expect(startSession(bindings, p)).rejects.toThrow("unbound home blocked");
      expect(bind.mock.calls[0]?.[5]).toBe(true);
      expect(openSession).not.toHaveBeenCalled();
    }
  });
});
