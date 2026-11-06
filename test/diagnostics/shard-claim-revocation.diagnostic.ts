import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Directory } from "../../src/directory/directory";
import { directory, directoryByName } from "../../src/shared/stubs";

// Known-unmet invariant: revoking a grant before the target create starts
// should prevent that already-claimed authorization from creating an account.
// Run with RESUMATIC_PLACEMENT_DIAGNOSTIC=1; this currently fails intentionally.
it("does not create a shard account after its claimed invitation was revoked", async () => {
  const global = directory(env), nonce = crypto.randomUUID(), email = `revoked-${nonce}@example.test`;
  const subject = `revoked-${nonce}`, shard = 5;
  await global.addInvite(email);
  const epoch = await global.googleAuthEpoch();
  const { shardInviteClaim: claim } = await global.claimIdentityHomeV3("google", subject, shard, email, undefined, epoch);
  expect(claim).not.toBeNull();
  await global.removeInviteV2(email);
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(false);

  // Delay the first target RPC until after the admin's revocation is committed.
  const target = directoryByName(env, `directory-${shard}`);
  const created = await target.signInWithInviteClaim({
    provider: "google", subject, email, hint: "enam", homeShard: shard, inviteAuthorized: true,
    authEpoch: epoch, shardClaimToken: claim!.token, shardInviteClaim: claim!, reportCreation: true,
  });
  // The coordinator rejects a new bind after revocation, so this target does
  // not receive a session. It still exists without a bound global home.
  await runInDurableObject(global, async (instance) => {
    await expect((instance as Directory).bindIdentityHomeV3("google", subject, created.userId, epoch, undefined, false, created.shardInviteClaim!))
      .rejects.toThrow("this email has not been invited");
  });
  expect(await runInDurableObject(global, (_instance, state) =>
    state.storage.sql.exec<{ user_id: string | null }>(
      `SELECT user_id FROM identity_homes WHERE provider='google' AND subject=?`, subject,
    ).one().user_id,
  )).toBeNull();
  expect(await target.existingIdentity("google", subject)).toBeNull();
}, 30_000);
