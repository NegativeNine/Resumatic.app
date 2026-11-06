import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Directory } from "../../src/directory/directory";
import { directory, directoryByName } from "../../src/shared/stubs";

it("rejects a new shard-home bind after revocation and recovers after a reissue without changing its original binding", async () => {
  const global = directory(env), nonce = crypto.randomUUID(), email = `revoked-${nonce}@example.test`;
  const subject = `revoked-${nonce}`, shard = 5;
  await global.addInvite(email);
  const epoch = await global.googleAuthEpoch();
  const { shardInviteClaim: claim } = await global.claimIdentityHomeV3("google", subject, shard, email, undefined, epoch);
  expect(claim?.generation).toMatch(/^[a-f0-9]{32}$/);
  await global.removeInviteV2(email);
  const target = directoryByName(env, `directory-${shard}`);
  const created = await target.signInWithInviteClaim({
    provider: "google", subject, email, hint: "enam", homeShard: shard, inviteAuthorized: true,
    authEpoch: epoch, shardClaimToken: claim!.token, shardInviteClaim: claim!, reportCreation: true,
  });
  await runInDurableObject(global, async (instance, state) => {
    await expect((instance as Directory).bindIdentityHomeV3("google", subject, created.userId, epoch, undefined, false, created.shardInviteClaim!))
      .rejects.toThrow("this email has not been invited");
    expect(state.storage.sql.exec<{ user_id: string | null }>(
      `SELECT user_id FROM identity_homes WHERE provider='google' AND subject=?`, subject,
    ).one().user_id).toBeNull();
  });

  await global.addInvite(email);
  await global.bindIdentityHomeV3("google", subject, created.userId, epoch, undefined, true, created.shardInviteClaim!);
  await runInDurableObject(global, (_instance, state) => {
    const saved = state.storage.sql.exec<{ user_id: string; generation: string }>(
      `SELECT user_id,generation FROM shard_home_invite_claims WHERE provider='google' AND subject=?`, subject,
    ).one();
    const current = state.storage.sql.exec<{ generation: string }>(`SELECT generation FROM invites WHERE email=?`, email).one().generation;
    expect(saved).toEqual({ user_id: created.userId, generation: claim!.generation });
    expect(current).not.toBe(claim!.generation);
  });
}, 30_000);
