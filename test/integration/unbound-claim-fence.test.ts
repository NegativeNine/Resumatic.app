import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { directoryForSignIn } from "../../src/directory/routing";
import { directory } from "../../src/shared/stubs";

it("keeps an unbound shard claim when an older dispatch can still create an account", async () => {
  const global = directory(env);
  const subject = `pending-claim-${crypto.randomUUID()}@example.test`;
  const input = {
    provider: "google" as const,
    subject,
    email: subject,
    hint: "enam" as const,
    authEpoch: await global.googleAuthEpoch(),
  };
  await global.addInvite(subject);
  const held = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "16" }, input);
  const shard = held.input.homeShard!;
  expect(held.input.shardClaimToken).toBeTruthy();
  expect(held.input.shardInviteClaim?.token).toBe(held.input.shardClaimToken);
  expect(await held.directory.existingIdentity("google", subject)).toBeNull();

  // An unrelated deletion advances the coordinator epoch, but has not
  // installed a newer floor in this target. A read of the empty shard and
  // the newer global epoch therefore do not prove this dispatch is gone.
  await runInDurableObject(global, (_instance, state) => {
    state.storage.sql.exec(`UPDATE meta SET value=? WHERE key='global_auth_epoch'`, String(input.authEpoch + 1));
  });
  const created = await held.directory.signInWithInviteClaim({ ...held.input, reportCreation: true });
  expect(created.shardClaimToken).toBe(held.input.shardClaimToken);
  expect(created.shardInviteClaim).toEqual(held.input.shardInviteClaim);
  await runInDurableObject(global, async (instance, state) => {
    await expect(instance.forgetGoogleShardHomeV3(subject, shard, created.userId))
      .rejects.toThrow("account placement requires review");
    const home = state.storage.sql.exec<{ user_id: string | null }>(
      `SELECT user_id FROM identity_homes WHERE provider='google' AND subject=?`, subject,
    ).one();
    expect(home.user_id).toBeNull();
  });

  // A fresh authorization can bind this actual account by its token, rather
  // than treating the old empty observation as authority to erase the home.
  const fresh = { ...input, authEpoch: await global.googleAuthEpoch() };
  const account = await held.directory.signInWithInviteClaim({ ...fresh, homeShard: shard, expectedUserId: created.userId, reportCreation: true });
  expect(account.shardInviteClaim).toEqual(created.shardInviteClaim);
  // A V2 caller cannot bind a V3 claim by presenting only its older token.
  await runInDurableObject(global, async (instance) => {
    await expect(instance.bindIdentityHomeV2("google", subject, account.userId, fresh.authEpoch, undefined, true, account.shardClaimToken))
      .rejects.toThrow("shard_invite_binding_required");
  });
  await global.bindIdentityHomeV3("google", subject, account.userId, fresh.authEpoch, undefined, true, account.shardInviteClaim ?? null);
  expect(await held.directory.existingIdentity("google", subject)).toMatchObject({ userId: created.userId });
});
