import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { directoryForSignIn } from "../../src/directory/routing";
import type { Directory } from "../../src/directory/directory";
import {
  allDirectories,
  directory,
  directoryForUser,
} from "../../src/shared/stubs";
import type { SignInInput } from "../../src/shared/types";
import { eventually } from "./support";

function input(): SignInInput {
  const id = crypto.randomUUID();
  return {
    provider: "google",
    subject: `subject-${id}`,
    email: `shard-${id}@example.test`,
    hint: "enam",
  };
}
const configured = (shards: string): Env => ({
  ...env,
  DIRECTORY_SHARDS: shards,
});

describe("Directory placement in Durable Objects", () => {
  it("preserves legacy accounts and keeps newly sharded accounts reachable after disabling creation", async () => {
    const legacyInput = input();
    await directory(env).addInvite(legacyInput.email);
    const legacy = await directory(env).signIn(legacyInput);
    const legacyTarget = await directoryForSignIn(
      configured("16"),
      legacyInput,
    );
    expect(await legacyTarget.directory.signIn(legacyTarget.input)).toEqual(
      legacy,
    );

    const shardInput = input();
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
    const p = input();
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
    const p = input();
    await directory(env).addInvite(p.email);
    const target = await directoryForSignIn(configured("16"), p);
    const account = await target.directory.signIn(target.input);
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
      const p = input();
      await directory(env).addInvite(p.email);
      const initial = await directoryForSignIn(configured(oldPlacement), p);
      const old = await initial.directory.signIn(initial.input);
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
      const fresh = await directoryForSignIn(configured(newPlacement), p);
      const replacement = await fresh.directory.signIn(fresh.input);
      expect(replacement.userId).not.toBe(old.userId);
      await runInDurableObject(stale.directory, async (instance) => {
        await expect((instance as Directory).signIn(stale.input)).rejects.toThrow("account changed");
      });
      const locations = await Promise.all(
        [...allDirectories(env)].map((d) => d.existingIdentity(p.provider, p.subject)),
      );
      expect(locations.filter(Boolean)).toEqual([replacement]);
    },
    30_000,
  );
});
