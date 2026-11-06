import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Directory } from "../../src/directory/directory";
import { directoryForSignIn } from "../../src/directory/routing";
import { identityShard } from "../../src/shared/operations";
import { directory } from "../../src/shared/stubs";
import type { SignInInput } from "../../src/shared/types";

// Opt-in diagnostic: a shard identity absent from the coordinator can share
// the invitation, and must keep it while the global account is erased.
it("preserves a global user's invitation when an unindexed shard identity shares it", async () => {
  const global = directory(env), id = crypto.randomUUID();
  const email = `global-orphan-${id}@example.test`;
  const input: SignInInput = { provider: "google", subject: `global-${id}`, email, hint: "enam", authEpoch: await global.googleAuthEpoch() };
  await global.addInvite(email);
  const target = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "1" }, input);
  const account = await target.directory.signIn(target.input);
  expect(account.userId).not.toContain(":");
  await global.bindIdentityHome(input.provider, input.subject, account.userId, input.authEpoch);

  const otherSubject = `unindexed-${crypto.randomUUID()}`;
  const shard = await identityShard("google", otherSubject);
  const orphan = env.DIRECTORY.getByName(`directory-${shard}`);
  const other = await orphan.signIn({ ...input, subject: otherSubject, homeShard: shard, inviteAuthorized: true });
  expect(await runInDurableObject(global, (_instance, state) => state.storage.sql.exec(
    `SELECT subject FROM identity_homes WHERE provider='google' AND subject=?`, otherSubject,
  ).toArray())).toHaveLength(0);

  await target.directory.deleteAccount(account.userId, account.vaultId);
  await runInDurableObject(target.directory, async (instance) => {
    const local = (instance as unknown as { env: Env }).env, delay = local.SWEEP_DELAY_MS;
    local.SWEEP_DELAY_MS = "0";
    try { await (instance as Directory).alarm(); }
    finally { local.SWEEP_DELAY_MS = delay; }
  });
  expect((await orphan.existingIdentity("google", otherSubject))?.userId).toBe(other.userId);
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(true);
  expect(await global.deletionProbe(account.userId, account.vaultId)).toBe(0);
});

it("removes the grant after simultaneous global and shard deletions leave no active account", async () => {
  const global = directory(env), token = crypto.randomUUID();
  const email = `simultaneous-${token}@example.test`, epoch = await global.googleAuthEpoch();
  await global.addInvite(email);
  const home = await global.signIn({ provider: "google", subject: `global-${token}`, email, hint: "enam", authEpoch: epoch });
  const subject = `orphan-${token}`, shard = await identityShard("google", subject);
  const otherDirectory = env.DIRECTORY.getByName(`directory-${shard}`);
  const other = await otherDirectory.signIn({ provider: "google", subject, email, hint: "enam", homeShard: shard, inviteAuthorized: true, authEpoch: epoch });
  await otherDirectory.deleteAccount(other.userId, other.vaultId);
  await global.deleteAccount(home.userId, home.vaultId);
  await runInDurableObject(global, async (instance) => (instance as Directory).alarm());
  await runInDurableObject(otherDirectory, async (instance) => (instance as Directory).alarm());
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(false);
  expect(await global.deletionProbe(home.userId, home.vaultId)).toBe(0);
  expect(await otherDirectory.deletionProbe(other.userId, other.vaultId)).toBe(0);
});
