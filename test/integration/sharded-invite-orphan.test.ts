import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import type { Directory } from "../../src/directory/directory";
import { directoryForSignIn } from "../../src/directory/routing";
import { identityShard } from "../../src/shared/operations";
import { directory } from "../../src/shared/stubs";
import type { SignInInput } from "../../src/shared/types";

it("keeps a shared invitation while an unindexed shard identity may use it", async () => {
  const global = directory(env), id = crypto.randomUUID();
  const email = `orphan-invite-${id}@example.test`;
  const input: SignInInput = { provider: "google", subject: `original-${id}`, email, hint: "enam", authEpoch: await global.googleAuthEpoch() };
  await global.addInvite(email);
  const target = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "16" }, input);
  const account = await target.directory.signIn(target.input);
  await global.bindIdentityHomeV2(input.provider, input.subject, account.userId, input.authEpoch, undefined, false, target.input.shardClaimToken);

  // Simulate an older direct shard creation whose coordinator claim is absent.
  // The coordinator cannot infer this account's email from its homes table.
  const firstShard = await identityShard(input.provider, input.subject);
  let otherSubject = "", otherShard = firstShard;
  for (let i = 0; i < 100 && otherShard === firstShard; i++) {
    otherSubject = `orphan-${crypto.randomUUID()}`;
    otherShard = await identityShard("google", otherSubject);
  }
  expect(otherShard).not.toBe(firstShard);
  const orphan = env.DIRECTORY.getByName(`directory-${otherShard}`);
  const other = await orphan.signIn({ ...input, subject: otherSubject, homeShard: otherShard, inviteAuthorized: true });
  const indexed = await runInDurableObject(global, (_instance, state) =>
    state.storage.sql.exec(`SELECT subject FROM identity_homes WHERE provider='google' AND subject=?`, otherSubject).toArray(),
  );
  expect(indexed).toHaveLength(0);

  await target.directory.deleteAccount(account.userId, account.vaultId);
  await runInDurableObject(target.directory, async (instance) => {
    const local = (instance as unknown as { env: Env }).env, delay = local.SWEEP_DELAY_MS;
    local.SWEEP_DELAY_MS = "0";
    try { await (instance as Directory).alarm(); }
    finally { local.SWEEP_DELAY_MS = delay; }
  });
  expect((await global.listInvites()).some((invite) => invite.email === email)).toBe(true);
  expect(await target.directory.deletionProbe(account.userId, account.vaultId)).toBeGreaterThan(0);
  expect((await orphan.existingIdentity("google", otherSubject))?.userId).toBe(other.userId);
});
