import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Directory } from "../../src/directory/directory";
import { directory, directoryByName } from "../../src/shared/stubs";

it("fences a delayed shard create across revocation and a later reissue", async () => {
  const global = directory(env), nonce = crypto.randomUUID(), email = `revoked-${nonce}@example.test`;
  const subject = `revoked-${nonce}`, shard = 5;
  await global.addInvite(email);
  const epoch = await global.googleAuthEpoch();
  const { shardInviteClaim: claim } = await global.claimIdentityHomeV3("google", subject, shard, email, undefined, epoch);
  expect(claim?.generation).toMatch(/^[a-f0-9]{32}$/);
  expect((await global.revokeInviteV3(email, crypto.randomUUID())).state).toBe("complete");
  const target = directoryByName(env, `directory-${shard}`);
  const input = { provider: "google" as const, subject, email, hint: "enam" as const, homeShard: shard, inviteAuthorized: true,
    authEpoch: epoch, shardClaimToken: claim!.token, shardInviteClaim: claim!, reportCreation: true };
  await runInDurableObject(target, async (instance) => {
    await expect((instance as Directory).signInWithInviteClaim(input)).rejects.toThrow("no longer available");
    await expect((instance as Directory).signInWithInviteClaimV2(input)).rejects.toThrow("no longer available");
  });
  await global.addInvite(email);
  const freshEpoch = await global.googleAuthEpoch();
  const fresh = (await global.claimIdentityHomeV3("google", subject, shard, email, undefined, freshEpoch)).shardInviteClaim!;
  expect(fresh.token).not.toBe(claim!.token);
  expect(fresh.generation).not.toBe(claim!.generation);
  const created = await target.signInWithInviteClaimV2({ ...input, authEpoch: freshEpoch, shardClaimToken: fresh.token, shardInviteClaim: fresh });
  await global.bindIdentityHomeV3("google", subject, created.userId, freshEpoch, undefined, false, fresh);
  await runInDurableObject(target, async (instance) => {
    await expect((instance as Directory).signInWithInviteClaimV2(input)).rejects.toThrow("no longer available");
  });
}, 30_000);
