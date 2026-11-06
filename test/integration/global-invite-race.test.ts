import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import type { Directory } from "../../src/directory/directory";
import { directoryForSignIn } from "../../src/directory/routing";
import { directory } from "../../src/shared/stubs";
import type { SignInInput } from "../../src/shared/types";
import { eventually } from "./support";

async function input(): Promise<SignInInput> {
  const id = crypto.randomUUID();
  return { provider: "google", subject: `invite-${id}`, email: `invite-${id}@example.test`, hint: "enam", authEpoch: await directory(env).googleAuthEpoch() };
}

describe("global-home invite authorization", () => {
  it("rejects a stale authorization after deletion, and accepts a new invite", async () => {
    const p = await input();
    const global = directory(env);
    await global.addInvite(p.email);
    // This decision predates the other sign-in and must not authorize a later
    // creation after deletion has revoked the invitation.
    const held = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "1" }, p);
    expect(held.input.inviteAuthorized).toBe(true);
    expect(held.input.expectedUserId).toBeUndefined();
    const original = await held.directory.signIn(held.input);
    await global.bindIdentityHome(p.provider, p.subject, original.userId, p.authEpoch);
    await global.deleteAccount(original.userId, original.vaultId);
    await runDurableObjectAlarm(global);
    await eventually(async () => !(await global.existingIdentity(p.provider, p.subject)), "identity erasure");
    expect((await global.listInvites()).some((invite) => invite.email === p.email)).toBe(false);
    await runInDurableObject(held.directory, async (instance) => {
      await expect((instance as Directory).signIn(held.input)).rejects.toThrow(/sign-in is stale|not been invited/);
    });
    expect(await global.existingIdentity(p.provider, p.subject)).toBeNull();

    await global.addInvite(p.email);
    const fresh = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "1" }, { ...p, authEpoch: await global.googleAuthEpoch() });
    const replacement = await fresh.directory.signIn(fresh.input);
    expect(replacement.userId).not.toBe(original.userId);
    expect(await fresh.directory.signIn(fresh.input)).toEqual(replacement);
  }, 30_000);

  it("keeps existing accounts accessible when their invite is removed", async () => {
    const p = await input();
    const global = directory(env);
    await global.addInvite(p.email);
    const account = await global.signIn(p);
    expect(await global.revokeInviteV3(p.email, crypto.randomUUID())).toMatchObject({ state: "complete" });
    expect(await global.signIn(p)).toEqual(account);
  }, 30_000);

  it("preserves explicit open registration and test identities", async () => {
    const global = directory(env);
    const p = await input();
    await runInDurableObject(global, async (instance) => {
      const local = (instance as unknown as { env: Env }).env;
      const previous = local.INVITE_ONLY;
      try {
        local.INVITE_ONLY = "false";
        expect((await (instance as Directory).signIn(p)).userId).toBeTruthy();
      } finally {
        local.INVITE_ONLY = previous;
      }
    });
    const email = `test-${crypto.randomUUID()}@example.test`;
    // Test login reads a fresh epoch before routing, just like the Worker.
    expect((await global.signIn({ provider: "test", subject: email, email, hint: "enam", authEpoch: await global.googleAuthEpoch() })).userId).toBeTruthy();
  }, 30_000);

  it("preserves control-plane authorization for a new sharded account", async () => {
    const p = await input();
    await directory(env).addInvite(p.email);
    const routed = await directoryForSignIn({ ...env, DIRECTORY_SHARDS: "16" }, p);
    expect(routed.input.inviteAuthorized).toBe(true);
    expect(routed.input.shardInviteClaim).toBeDefined();
    const account = await routed.directory.signInWithInviteClaim({ ...routed.input, reportCreation: true });
    expect(account.userId).toMatch(/^s(?:[0-9]|1[0-5]):/);
    expect(account.shardInviteClaim).toEqual(routed.input.shardInviteClaim);
    await directory(env).bindIdentityHomeV3(p.provider, p.subject, account.userId, p.authEpoch, undefined, false, account.shardInviteClaim ?? null);
  }, 30_000);
});
