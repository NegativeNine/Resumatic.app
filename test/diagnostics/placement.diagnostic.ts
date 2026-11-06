import { runDurableObjectAlarm } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { directoryForSignIn } from "../../src/directory/routing";
import { allDirectories, directory, directoryForUser } from "../../src/shared/stubs";
import type { SignInInput } from "../../src/shared/types";
import { eventually } from "../integration/support";

// This opt-in diagnostic asserts the desired invariant. It currently fails:
// an old, unregistered creation can create a second account after erasure.
// It uses ephemeral local Durable Objects and never contacts a model provider.
it("does not create two accounts when an old placement resumes after deletion", async () => {
  const nonce = crypto.randomUUID();
  const input: SignInInput = { provider: "google", subject: `subject-${nonce}`, email: `example-${nonce}@example.test`, hint: "enam", authEpoch: await directory(env).googleAuthEpoch() };
  const configured = (shards: string): Env => ({ ...env, DIRECTORY_SHARDS: shards });
  await directory(env).addInvite(input.email);
  const held = await directoryForSignIn(configured("16"), input);
  const initial = await directoryForSignIn(configured("16"), input);
  const old = await initial.directory.signIn(initial.input);
  await directory(env).bindIdentityHome(input.provider, input.subject, old.userId, input.authEpoch);
  const home = directoryForUser(env, old.userId);
  await home.deleteAccount(old.userId, old.vaultId);
  await runDurableObjectAlarm(home);
  await eventually(async () => (await home.existingIdentity(input.provider, input.subject)) === null, "identity deletion");
  await directory(env).addInvite(input.email);
  const freshInput = { ...input, authEpoch: await directory(env).googleAuthEpoch() };
  const fresh = await directoryForSignIn(configured("1"), freshInput);
  const replacement = await fresh.directory.signIn(fresh.input);
  await directory(env).bindIdentityHome(input.provider, input.subject, replacement.userId, freshInput.authEpoch);
  await held.directory.signIn(held.input);
  const locations = await Promise.all([...allDirectories(env)].map((d) => d.existingIdentity(input.provider, input.subject)));
  expect(locations.filter(Boolean), "a stale creation left two accounts for the same identity").toHaveLength(1);
}, 30_000);
