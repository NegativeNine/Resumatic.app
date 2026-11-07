import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { directoryForSignIn } from "../../src/directory/routing";
import { directory } from "../../src/shared/stubs";
import type { SignInInput } from "../../src/shared/types";

it("recovers a sharded account whose home bind was interrupted by another account's deletion", async () => {
  const global = directory(env);
  const nonce = crypto.randomUUID();
  const epoch = await global.googleAuthEpoch();
  const sharded: SignInInput = {
    provider: "google",
    subject: `shard-a-${nonce}`,
    email: `shard-a-${nonce}@example.test`,
    hint: "enam",
    authExpiryMs: Date.now() + 600_000,
    authEpoch: epoch,
  };
  const unrelated: SignInInput = {
    provider: "google",
    subject: `global-b-${nonce}`,
    email: `global-b-${nonce}@example.test`,
    hint: "enam",
    authExpiryMs: Date.now() + 600_000,
    authEpoch: epoch,
  };
  await global.addInvite(sharded.email);
  await global.addInvite(unrelated.email);

  const target = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "16" }, sharded);
  expect(target.input.shardInviteClaim).toBeDefined();
  const created = await target.directory.signInWithInviteClaim({ ...target.input, reportCreation: true });
  expect(created.userId).toMatch(/^s\d+:/);
  expect(created.shardInviteClaim).toEqual(target.input.shardInviteClaim);

  const other = await global.signIn(unrelated);
  await global.deleteAccount(other.userId, other.vaultId);
  await runInDurableObject(global, async (instance) => {
    // A pre-upgrade caller is still rejected on its stale epoch.
    await expect(
      instance.bindIdentityHome(sharded.provider, sharded.subject, created.userId, epoch),
    ).rejects.toThrow("sign-in is stale");
    await expect(
      instance.bindIdentityHomeV3(sharded.provider, sharded.subject, created.userId, epoch, undefined, false, created.shardInviteClaim ?? null),
    ).rejects.toThrow("sign-in is stale");
  });

  // The target account exists, but no session was returned and the global
  // home remains unbound until a later successful sign-in. This test does not
  // establish retention or automatic cleanup if that sign-in never happens.
  expect(await target.directory.existingIdentity(sharded.provider, sharded.subject)).toEqual({ userId: created.userId, vaultId: created.vaultId });
  const unbound = await runInDurableObject(global, (_instance, state) =>
    state.storage.sql.exec<{ user_id: string | null; shard: number | null }>(
      `SELECT user_id, shard FROM identity_homes WHERE provider=? AND subject=?`,
      sharded.provider,
      sharded.subject,
    ).one(),
  );
  expect(unbound.user_id).toBeNull();
  expect(unbound.shard).not.toBeNull();

  // Existing sharded accounts remain reachable even after new shard creation
  // has been disabled. The fresh authorization binds the same account.
  const fresh = { ...sharded, authEpoch: await global.googleAuthEpoch() };
  const retry = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "1" }, fresh);
  const recovered = await retry.directory.signInWithInviteClaim({ ...retry.input, reportCreation: true });
  expect(recovered.userId).toBe(created.userId);
  expect(recovered.shardInviteClaim).toEqual(created.shardInviteClaim);
  await global.bindIdentityHomeV3(sharded.provider, sharded.subject, created.userId, fresh.authEpoch, undefined, true, recovered.shardInviteClaim ?? null);
});
