import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Directory } from "../../src/directory/directory";
import { directory, directoryByName } from "../../src/shared/stubs";

// Revocation must seal an already-dispatched claim before reporting complete.
// Run with RESUMATIC_PLACEMENT_DIAGNOSTIC=1.
it("does not create a shard account after its claimed invitation was revoked", async () => {
  const global = directory(env), nonce = crypto.randomUUID(), email = `revoked-${nonce}@example.test`;
  const subject = `revoked-${nonce}`, shard = 5;
  await global.addInvite(email);
  const epoch = await global.googleAuthEpoch();
  const { shardInviteClaim: claim } = await global.claimIdentityHomeV3("google", subject, shard, email, undefined, epoch);
  expect(claim).not.toBeNull();
  const operation = crypto.randomUUID();
  expect(await global.revokeInviteV3(email, operation)).toMatchObject({ state: "complete" });
  expect(await global.inviteRevocationStatus(operation)).toMatchObject({ state: "complete" });
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(false);

  // Delay the first target RPC until after the admin's revocation is committed.
  const target = directoryByName(env, `directory-${shard}`);
  const rejected = await runInDurableObject(target, async (instance) => {
    try {
      await (instance as Directory).signInWithInviteClaimV2({
        provider: "google", subject, email, hint: "enam", homeShard: shard, inviteAuthorized: true,
        authEpoch: epoch, shardClaimToken: claim!.token, shardInviteClaim: claim!, reportCreation: true,
      });
      return false;
    } catch { return true; }
  });
  expect(rejected).toBe(true);
  expect(await runInDurableObject(global, (_instance, state) =>
    state.storage.sql.exec(
      `SELECT user_id FROM identity_homes WHERE provider='google' AND subject=?`, subject,
    ).toArray(),
  )).toHaveLength(0);
  expect(await target.existingIdentity("google", subject)).toBeNull();
  await runInDurableObject(target, (_instance, state) => {
    expect(state.storage.sql.exec(`SELECT user_id FROM shard_identity_claim_tokens WHERE token=?`, claim!.token).toArray()).toHaveLength(0);
    expect(state.storage.sql.exec(`SELECT user_id FROM shard_invite_account_bindings WHERE token=?`, claim!.token).toArray()).toHaveLength(0);
  });
}, 30_000);
