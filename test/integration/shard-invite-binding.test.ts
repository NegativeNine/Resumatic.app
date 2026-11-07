import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { directory, directoryByName } from "../../src/shared/stubs";
import type { Directory } from "../../src/directory/directory";
import { identityShard } from "../../src/shared/operations";
import { startSession } from "../../src/worker/routes";

const target = () => directoryByName(env, "directory-3");
const input = (subject: string, email: string, authEpoch: number) => ({ provider: "google" as const, subject, email, hint: "enam" as const, homeShard: 3, inviteAuthorized: true, authEpoch, reportCreation: true });

it("retains the original grant through reissue, target creation and a lost bind reply", async () => {
  const global = directory(env), shard = target(), subject = crypto.randomUUID(), email = `${subject}@example.test`;
  await global.addInvite(email);
  const epoch = await global.googleAuthEpoch();
  const first = await global.claimIdentityHomeV3("google", subject, 3, email, undefined, epoch);
  expect(first.shard).toBe(3);
  const claim = first.shardInviteClaim!;
  expect(claim.generation).toMatch(/^[a-f0-9]{32}$/);
  await global.addInvite(email);
  expect((await global.claimIdentityHomeV3("google", subject, 3, email, undefined, epoch)).shardInviteClaim).toEqual(claim);
  const account = await shard.signInWithInviteClaim({ ...input(subject, email, epoch), shardClaimToken: claim.token, shardInviteClaim: claim });
  expect(account.shardInviteClaim).toEqual(claim);
  // The former version cannot bind a V3 claim even with its opaque token.
  await runInDurableObject(global, async (instance) => {
    await expect((instance as Directory).bindIdentityHomeV2("google", subject, account.userId, epoch, undefined, false, claim.token))
      .rejects.toThrow("shard_invite_binding_required");
  });
  await global.bindIdentityHomeV3("google", subject, account.userId, epoch, undefined, false, account.shardInviteClaim!);
  // A fresh route finds the target first; its durable claim recovers a lost reply.
  const recovered = await shard.signInWithInviteClaim({ ...input(subject, email, epoch), expectedUserId: account.userId });
  expect(recovered.shardInviteClaim).toEqual(claim);
  await global.bindIdentityHomeV3("google", subject, account.userId, epoch, undefined, true, recovered.shardInviteClaim!);
  await runInDurableObject(shard, async (instance) => {
    await expect((instance as Directory).signInWithInviteClaim({ ...input(subject, `changed-${email}`, epoch), expectedUserId: account.userId }))
      .rejects.toThrow("account invitation requires review");
  });
  await runInDurableObject(global, (_instance, state) => {
    const row = state.storage.sql.exec<{ user_id: string; generation: string | null; email: string }>(
      `SELECT user_id,generation,email FROM shard_home_invite_claims WHERE provider='google' AND subject=?`, subject,
    ).one();
    expect(row).toEqual({ user_id: account.userId, generation: claim.generation, email });
  });
});

it("rejects changed emails, tokens and fabricated target claims", async () => {
  const global = directory(env), shard = target(), subject = crypto.randomUUID(), email = `${subject}@example.test`, other = `other-${subject}@example.test`;
  await global.addInvite(email);
  await global.addInvite(other);
  const epoch = await global.googleAuthEpoch();
  const claim = (await global.claimIdentityHomeV3("google", subject, 3, email, undefined, epoch)).shardInviteClaim!;
  await runInDurableObject(global, async (instance) => {
    await expect((instance as Directory).claimIdentityHomeV3("google", subject, 3, other, undefined, epoch)).rejects.toThrow("account placement changed");
  });
  await runInDurableObject(shard, async (instance) => {
    await expect((instance as Directory).signInWithInviteClaim({ ...input(subject, other, epoch), shardClaimToken: claim.token, shardInviteClaim: claim })).rejects.toThrow("invalid account placement");
  });
  const account = await shard.signInWithInviteClaim({ ...input(subject, email, epoch), shardClaimToken: claim.token, shardInviteClaim: claim });
  await runInDurableObject(global, async (instance) => {
    await expect((instance as Directory).bindIdentityHomeV3("google", subject, account.userId, epoch, undefined, false, { ...claim, token: crypto.randomUUID() }))
      .rejects.toThrow("account placement changed");
    await expect((instance as Directory).bindIdentityHomeV3("google", subject, account.userId, epoch, undefined, false, { ...claim, generation: "0".repeat(32) }))
      .rejects.toThrow("account placement changed");
  });
  await global.bindIdentityHomeV3("google", subject, account.userId, epoch, undefined, false, claim);
});

it("records verified absence without adopting an invitation issued later", async () => {
  const global = directory(env), shard = target(), subject = crypto.randomUUID(), email = `${subject}@example.test`;
  const epoch = await global.googleAuthEpoch();
  const claim = await runInDurableObject(global, async (instance) => {
    const local = (instance as unknown as { env: Env }).env, previous = local.INVITE_ONLY;
    local.INVITE_ONLY = "false";
    try { return (await (instance as Directory).claimIdentityHomeV3("google", subject, 3, email, undefined, epoch)).shardInviteClaim!; }
    finally { local.INVITE_ONLY = previous; }
  });
  expect(claim.generation).toBeNull();
  await global.addInvite(email);
  const account = await shard.signInWithInviteClaim({ ...input(subject, email, epoch), shardClaimToken: claim.token, shardInviteClaim: claim });
  await global.bindIdentityHomeV3("google", subject, account.userId, epoch, undefined, false, account.shardInviteClaim!);
  expect((await global.claimIdentityHomeV3("google", subject, 3, email, undefined, epoch)).shardInviteClaim).toEqual(claim);
});

it("does not backfill an older unbound home from the current invitation", async () => {
  const global = directory(env), subject = crypto.randomUUID(), email = `${subject}@example.test`;
  await global.addInvite(email);
  const epoch = await global.googleAuthEpoch();
  await global.claimIdentityHomeV2("google", subject, 3, email, undefined, epoch);
  await runInDurableObject(global, async (instance) => {
    await expect((instance as Directory).claimIdentityHomeV3("google", subject, 3, email, undefined, epoch)).rejects.toThrow("legacy account placement requires review");
  });
});

it("keeps an already-bound legacy account usable without inventing a binding", async () => {
  const global = directory(env), shard = target(), subject = crypto.randomUUID(), email = `${subject}@example.test`;
  await global.addInvite(email);
  const epoch = await global.googleAuthEpoch();
  const old = await global.claimIdentityHomeV2("google", subject, 3, email, undefined, epoch);
  const account = await shard.signIn({ ...input(subject, email, epoch), shardClaimToken: old.shardClaimToken! });
  await global.bindIdentityHomeV2("google", subject, account.userId, epoch, undefined, false, old.shardClaimToken);
  const recovered = await shard.signInWithInviteClaim({ ...input(subject, email, epoch), expectedUserId: account.userId });
  expect(recovered.shardInviteClaim).toBeNull();
  await global.bindIdentityHomeV3("google", subject, account.userId, epoch, undefined, true, null);
  await runInDurableObject(global, (_instance, state) => {
    expect(state.storage.sql.exec(`SELECT token FROM shard_home_invite_claims WHERE provider='google' AND subject=?`, subject).toArray()).toHaveLength(0);
  });
});

it("never binds a V3 claim to an account inserted by an older target without the claim", async () => {
  const global = directory(env), shard = target(), subject = crypto.randomUUID(), email = `${subject}@example.test`;
  await global.addInvite(email);
  const epoch = await global.googleAuthEpoch();
  const claim = (await global.claimIdentityHomeV3("google", subject, 3, email, undefined, epoch)).shardInviteClaim!;
  const old = await shard.signIn({ ...input(subject, email, epoch), shardClaimToken: claim.token });
  const recovered = await shard.signInWithInviteClaim({ ...input(subject, email, epoch), expectedUserId: old.userId });
  expect(recovered.shardInviteClaim).toBeNull();
  await runInDurableObject(global, async (instance) => {
    await expect((instance as Directory).bindIdentityHomeV3("google", subject, old.userId, epoch, undefined, true, null))
      .rejects.toThrow("account placement changed");
  });
});

it("issues and resumes a sharded session using the target's immutable binding", async () => {
  const global = directory(env), subject = crypto.randomUUID(), email = `${subject}@example.test`;
  await global.addInvite(email);
  const authEpoch = await global.googleAuthEpoch();
  const p = { provider: "google" as const, subject, email, hint: "enam" as const, authEpoch };
  const configured = { ...env, DIRECTORY_SHARDS: "16" };
  expect(await startSession(configured, p)).toContain("__Host-session=");
  const shard = directoryByName(env, `directory-${await identityShard("google", subject)}`);
  const identity = await shard.existingIdentity("google", subject);
  expect(identity).not.toBeNull();
  const saved = await runInDurableObject(global, (_instance, state) => state.storage.sql.exec<{ token: string; email: string; generation: string; user_id: string }>(
    `SELECT token,email,generation,user_id FROM shard_home_invite_claims WHERE provider='google' AND subject=?`, subject,
  ).one());
  expect(saved.user_id).toBe(identity!.userId);
  expect(saved.email).toBe(email);
  await global.addInvite(email);
  expect(await startSession(configured, p)).toContain("__Host-session=");
  expect(await runInDurableObject(global, (_instance, state) => state.storage.sql.exec(
    `SELECT token,email,generation,user_id FROM shard_home_invite_claims WHERE provider='google' AND subject=?`, subject,
  ).one())).toEqual(saved);
});
