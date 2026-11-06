import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { directoryForSignIn } from "../../src/directory/routing";
import { directory } from "../../src/shared/stubs";
import type { SignInInput } from "../../src/shared/types";
import { eventually } from "../integration/support";

// Expected to fail until public-registration sign-ins are fenced across deletion.
// All identities and Durable Objects are local and disposable.
it("does not recreate a global account when an old public sign-in resumes after deletion", async () => {
  const nonce = crypto.randomUUID();
  const input: SignInInput = {
    provider: "google",
    subject: `global-open-${nonce}`,
    email: `global-open-${nonce}@example.test`,
    hint: "enam",
    // Model a Google authorization that is still valid at every step.
    authExpiryMs: Date.now() + 10 * 60_000,
  };
  const global = directory(env);
  let previous: string | undefined;
  await runInDurableObject(global, async (instance) => {
    const local = (instance as unknown as { env: Env }).env;
    previous = local.INVITE_ONLY;
    local.INVITE_ONLY = "false";
  });
  try {
    const publicBindings = { ...env, INVITE_ONLY: "false", DIRECTORY_SHARDS: "1" };
    // The first authorization already chose the global home, but has not yet
    // reached its signIn RPC when a later sign-in and deletion complete.
    const held = await directoryForSignIn(publicBindings, input);
    const first = await directoryForSignIn(publicBindings, input);
    expect(held.input.expectedUserId).toBeUndefined();
    const account = await first.directory.signIn(first.input);
    await global.bindIdentityHome(input.provider, input.subject, account.userId);
    await global.deleteAccount(account.userId, account.vaultId);
    await runDurableObjectAlarm(global);
    await eventually(async () => !(await global.existingIdentity(input.provider, input.subject)), "global identity erasure");
    await held.directory.signIn(held.input);
    expect(await global.existingIdentity(input.provider, input.subject), "a pre-deletion public sign-in recreated the deleted account").toBeNull();
  } finally {
    await runInDurableObject(global, async (instance) => {
      (instance as unknown as { env: Env }).env.INVITE_ONLY = previous!;
    });
  }
}, 30_000);
