import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Directory } from "../../src/directory/directory";
import { directory, directoryByName } from "../../src/shared/stubs";

async function fixture() {
  const global = directory(env), id = crypto.randomUUID();
  const email = `inventory-create-${id}@example.test`, subject = `inventory-create-${id}`, shard = 4;
  await global.addInvite(email);
  const epoch = await global.googleAuthEpoch();
  const account = await global.signIn({ provider: "test", subject: `owner-${id}`, email, hint: "enam", authEpoch: epoch });
  const claim = await global.claimIdentityHomeV3("google", subject, shard, email, undefined, epoch);
  expect(claim.shardInviteClaim).not.toBeNull();
  const target = directoryByName(env, `directory-${shard}`);
  const request = { provider: "google" as const, subject, email, hint: "enam" as const,
    homeShard: shard, inviteAuthorized: true, authEpoch: epoch,
    shardClaimToken: claim.shardInviteClaim!.token, shardInviteClaim: claim.shardInviteClaim!, reportCreation: true };
  await global.deleteAccount(account.userId, account.vaultId);
  return { global, target, account, email, subject, request };
}

it.each(["signInWithInviteClaim", "signInWithInviteClaimV2"] as const)("preserves the grant when a dispatched %s creates before its shard is sealed", async (method) => {
  const f = await fixture();
  const created = await f.target[method](f.request);
  await runInDurableObject(f.global, async (instance) => (instance as Directory).alarm());
  expect((await f.global.listInvites()).some((invite) => invite.email === f.email)).toBe(true);
  expect(await f.target.existingIdentity("google", f.subject)).toEqual({ userId: created.userId, vaultId: created.vaultId });
  const owner = await runInDurableObject(f.global, (_instance, state) =>
    state.storage.sql.exec(`SELECT user_id FROM users WHERE user_id=?`, f.account.userId).toArray());
  expect(owner).toHaveLength(0);
}, 30_000);

it.each(["signInWithInviteClaim", "signInWithInviteClaimV2"] as const)("rejects a dispatched %s after its shard was sealed and the grant removed", async (method) => {
  const f = await fixture();
  await runInDurableObject(f.global, async (instance) => (instance as Directory).alarm());
  expect((await f.global.listInvites()).some((invite) => invite.email === f.email)).toBe(false);
  // Catch inside the DO callback: the workerd test RPC bridge can otherwise
  // report an expected remote rejection as a separate unhandled rejection.
  const rejected = await runInDurableObject(f.target, async (instance) => {
    try {
      await (instance as Directory)[method](f.request);
      return false;
    } catch {
      return true;
    }
  });
  expect(rejected).toBe(true);
  expect(await f.target.existingIdentity("google", f.subject)).toBeNull();
  await runInDurableObject(f.target, (_instance, state) => {
    expect(state.storage.sql.exec(`SELECT user_id FROM shard_identity_claim_tokens WHERE token=?`, f.request.shardClaimToken).toArray()).toHaveLength(0);
    expect(state.storage.sql.exec(`SELECT user_id FROM shard_invite_account_bindings WHERE token=?`, f.request.shardClaimToken).toArray()).toHaveLength(0);
  });
}, 30_000);
