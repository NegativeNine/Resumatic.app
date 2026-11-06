import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { directoryForSignIn } from "../../src/directory/routing";
import { Directory } from "../../src/directory/directory";
import { allDirectories, directory, directoryForUser } from "../../src/shared/stubs";
import type { SignInInput } from "../../src/shared/types";
import { eventually } from "../integration/support";

// Opt-in local diagnostic for an old creation held across deletion and replacement.
// It uses ephemeral Durable Objects and never contacts a model provider.
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
  await runInDurableObject(held.directory, async (instance) => {
    await expect((instance as Directory).signIn(held.input)).rejects.toThrow("sign-in is stale");
  });
  const locations = await Promise.all([...allDirectories(env)].map((d) => d.existingIdentity(input.provider, input.subject)));
  expect(locations.filter(Boolean), "a stale creation left two accounts for the same identity").toHaveLength(1);
}, 30_000);
