import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { directoryForSignIn, settleRoutedPlacement } from "../../src/directory/routing";
import { allDirectories, directory, directoryByName, directoryForUser } from "../../src/shared/stubs";
import { identityShard } from "../../src/shared/operations";
import type { SignInInput } from "../../src/shared/types";
import { eventually } from "../integration/support";

// These opt-in diagnostics assert desired invariants and currently fail.
// They use synthetic local Durable Objects and no external provider calls.
it("does not recreate a deleted synthetic account when a pre-deletion epoch read arrives late", async () => {
  const email = `placement-${crypto.randomUUID()}@placement.invalid`;
  const input: SignInInput = { provider: "test", subject: email, email, hint: "enam" };
  const bindings: Env = { ...env, DIRECTORY_SHARDS: "16", PLACEMENT_FENCE_ENABLED: "true" };
  const shard = await identityShard(input.provider, input.subject);
  // A's initial epoch-read RPC has not reached the coordinator; no marker or
  // old epoch is available to distinguish it from a genuinely new sign-in.
  const delayedEpoch = () => directory(env).placementEpoch();
  const first = await directoryForSignIn(bindings, input);
  const account = await first.directory.signIn(first.input);
  await settleRoutedPlacement(bindings, first.directory, first.input);
  await directory(env).bindIdentityHome(input.provider, input.subject, account.userId);
  const home = directoryForUser(env, account.userId);
  await home.deleteAccount(account.userId, account.vaultId);
  await runDurableObjectAlarm(home);
  await eventually(async () => !(await home.existingIdentity(input.provider, input.subject)), "synthetic identity erasure");
  const staleAttempt = await directory(env).reservePlacementAttempt(input.provider, input.subject, shard, await delayedEpoch());
  const target = directoryByName(env, `directory-${shard}`);
  await target.signIn({ ...input, homeShard: shard, inviteAuthorized: true, placementAttempt: staleAttempt });
  const locations = await Promise.all([...allDirectories(env)].map((d) => d.existingIdentity(input.provider, input.subject)));
  expect(locations.filter(Boolean), "a pre-deletion epoch read recreated the deleted account").toHaveLength(0);
}, 30_000);

it("does not create an account using an invite check completed before deletion revoked it", async () => {
  const nonce = crypto.randomUUID();
  const input: SignInInput = { provider: "google", subject: `stale-invite-${nonce}`, email: `stale-invite-${nonce}@example.test`, hint: "enam" };
  const global = directory(env);
  await global.addInvite(input.email);
  // A's claim was already dispatched to the sharded target, but that target
  // has not received it. Claim-time revalidation cannot cancel an older RPC.
  const held = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "16" }, input);
  const first = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "16" }, input);
  const account = await first.directory.signIn(first.input);
  await global.bindIdentityHome(input.provider, input.subject, account.userId);
  const home = directoryForUser(env, account.userId);
  await home.deleteAccount(account.userId, account.vaultId);
  await runDurableObjectAlarm(home);
  await eventually(async () => !(await home.existingIdentity(input.provider, input.subject)), "invited identity erasure");
  await held.directory.signIn(held.input);
  const locations = await Promise.all([...allDirectories(env)].map((d) => d.existingIdentity(input.provider, input.subject)));
  expect(locations.filter(Boolean), "a stale invite authorization recreated the deleted account").toHaveLength(0);
}, 30_000);
