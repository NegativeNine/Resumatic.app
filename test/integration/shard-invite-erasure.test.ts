import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Directory } from "../../src/directory/directory";
import { boundShardInviteClaim } from "../../src/directory/shard-invite-owner";
import { directory, directoryByName } from "../../src/shared/stubs";

async function newBoundShardAccount(reissueBeforeCreate: boolean) {
  const global = directory(env), id = crypto.randomUUID(), email = `shard-bound-${id}@example.test`;
  const subject = `google-${id}`, shard = 5;
  await global.addInvite(email);
  const authEpoch = await global.googleAuthEpoch();
  const claimed = await global.claimIdentityHomeV3("google", subject, shard, email, undefined, authEpoch);
  expect(claimed.shard).toBe(shard);
  expect(claimed.shardInviteClaim).not.toBeNull();
  if (reissueBeforeCreate) await global.addInvite(email);
  const home = directoryByName(env, `directory-${shard}`);
  const account = await home.signInWithInviteClaim({
    provider: "google", subject, email, hint: "enam", homeShard: shard, inviteAuthorized: true,
    authEpoch, shardClaimToken: claimed.shardInviteClaim!.token,
    shardInviteClaim: claimed.shardInviteClaim!, reportCreation: true,
  });
  expect(account.shardInviteClaim).toEqual(claimed.shardInviteClaim);
  await global.bindIdentityHomeV3("google", subject, account.userId, authEpoch, undefined, false, account.shardInviteClaim!);
  return { global, home, account, email };
}

it("erases a new shard account and its exclusive original invitation", async () => {
  const { global, home, account, email } = await newBoundShardAccount(false);
  await home.deleteAccount(account.userId, account.vaultId);
  await runInDurableObject(home, async (instance) => (instance as Directory).alarm());
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(false);
  expect(await home.deletionProbe(account.userId, account.vaultId)).toBe(0);
  expect(await global.deletionProbe(account.userId, account.vaultId)).toBe(0);
}, 30_000);

it("preserves an invitation reissued between the shard claim and account creation", async () => {
  const { global, home, account, email } = await newBoundShardAccount(true);
  await home.deleteAccount(account.userId, account.vaultId);
  await runInDurableObject(home, async (instance) => (instance as Directory).alarm());
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(true);
  expect(await home.deletionProbe(account.userId, account.vaultId)).toBe(0);
  expect(await global.deletionProbe(account.userId, account.vaultId)).toBe(0);
}, 30_000);

it("removes a shared invitation when the bound shard account is deleted last", async () => {
  const { global, home, account, email } = await newBoundShardAccount(false);
  const other = await global.signIn({ provider: "test", subject: `global-${crypto.randomUUID()}`,
    email, hint: "enam", authEpoch: await global.googleAuthEpoch() });
  await global.deleteAccount(other.userId, other.vaultId);
  await runInDurableObject(global, async (instance) => (instance as Directory).alarm());
  expect(await global.deletionProbe(other.userId, other.vaultId)).toBe(0);
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(true);
  await home.deleteAccount(account.userId, account.vaultId);
  await runInDurableObject(home, async (instance) => (instance as Directory).alarm());
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(false);
  expect(await home.deletionProbe(account.userId, account.vaultId)).toBe(0);
  expect(await global.deletionProbe(account.userId, account.vaultId)).toBe(0);
}, 30_000);

it("rejects conflicting global claim records for a shard user", async () => {
  const { global, account, email } = await newBoundShardAccount(false);
  await runInDurableObject(global, (_instance, state) => {
    state.storage.sql.exec(`INSERT INTO shard_home_invite_claims(provider,subject,token,email,generation,user_id)
      VALUES ('google',?,?,?,?,?)`, `duplicate-${crypto.randomUUID()}`, crypto.randomUUID(), email, "a".repeat(32), account.userId);
    expect(() => boundShardInviteClaim(state.storage.sql, account.userId, email)).toThrow("invitation binding requires review");
  });
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(true);
}, 30_000);
